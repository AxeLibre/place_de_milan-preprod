// Mode Architecte — planche de nomenclature plein écran (vue d'ensemble
// orientable + fiches de nomenclature par nouveau bâtiment + extension
// gare). Extrait d'index.html.
//
// Dépendances externes non encore extraites, injectées via
// initCameraArchitect() : fonctions/état d'autres outils qui n'ont pas
// encore leur propre module (piéton, vue globale, dessin, arbres, gazon,
// labels, édition/déplacement de bâtiment, vue plan, véhicules/piétons).

import * as THREE from "three";
import {
  scene, camera, controls, renderer, orthoCamera, worldRoot, siteRoot,
  globalRoot, buildZone, buildings, hallMesh, treesGroup, quartierGroup,
  sun, hemiLight, labels, drawing, drawMenuOpen, treePlacing, grassPainting,
  labelPlacing, editingBuildingId, planViewActive, amenagementPlacing,
} from './state.js';
import { polygonAreaXZ } from './geometry-utils.js';
import { USAGE_COLORS, USAGE_LABELS } from './config.js';
import { footprintForBand, usageAtFloor, buildingTotalHeight, buildingTotalFloorArea, floorHeightFor } from './building-utils.js';
import * as ExtGare from './extension-gare.js';
import * as CameraSkyline from './camera-skyline.js';

let exitPedestrianMode, getPedestrianModeActive, getGlobalViewActive,
    exitGlobalView, cancelDraw, closeDrawMenu, stopTreeTool, stopGrassTool,
    stopLabelTool, stopEditBuildingShape, getMovingBuildingId, stopMoveBuilding,
    closeBldgEditWindow, togglePlanView, applyAgentTypeVisibility,
    getVehiclesVisible, setVehiclesVisible, getPedestriansVisible, setPedestriansVisible,
    stopAmenagementsTool, refreshNightLighting;
export function initCameraArchitect(deps){
  ({
    exitPedestrianMode, getPedestrianModeActive, getGlobalViewActive,
    exitGlobalView, cancelDraw, closeDrawMenu, stopTreeTool, stopGrassTool,
    stopLabelTool, stopEditBuildingShape, getMovingBuildingId, stopMoveBuilding,
    closeBldgEditWindow, togglePlanView, applyAgentTypeVisibility,
    getVehiclesVisible, setVehiclesVisible, getPedestriansVisible, setPedestriansVisible,
    stopAmenagementsTool, refreshNightLighting,
  } = deps);
}

/* ------------------------------------------------------------
   MODE ARCHITECTE — planche de nomenclature plein écran (comme les
   autres modes plein écran ci-dessus) : une image principale orthogonale
   de l'ensemble du polygone d'implantation (vue de haut ou élévation
   orientable N/S/E/O, avec ou sans labels) entourée, sur les côtés droit
   et bas, d'une fiche par nouveau bâtiment (élévation orientable + sa
   nomenclature : nom, hauteur, étages, m² au sol, m² développés, m² par
   usage), plus l'extension gare en première case du bas (élévation
   orientable ou vue de haut, synchro avec la principale).
   Implémentation : chaque panneau est rendu séparément (caméra
   orthographique partagée `orthoCamera`, cadrée sur la boîte englobante
   de son propre sujet) dans une cible de rendu hors-écran, puis composé
   avec sa légende sur UN SEUL canvas 2D plein écran (#architect-canvas)
   — image figée, recalculée uniquement au changement d'orientation/de
   sélection, jamais à chaque frame. La même fonction de composition sert
   à l'affichage écran et à l'export PNG (résolution plus élevée).
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   MODE ARCHITECTE — planche de nomenclature plein écran.
   Une image d'ensemble RENDUE EN 3D (plan de haut, élévation orientable
   N/S/E/O, ou axonométrie — au choix) montre le site réel (existant +
   nouveaux bâtiments + extension gare + gazon/arbres), tandis que CHAQUE
   nouveau bâtiment reçoit une fiche entièrement calculée à partir des
   données du projet (pas un rendu 3D) : une "coupe" schématique — pile de
   niveaux colorés par usage, largeur en retrait selon l'emprise réelle de
   chaque bande — plus sa nomenclature complète (hauteur, étages, m² au
   sol, m² développés, m² par usage). Cette approche évite tout problème
   d'éclairage/cadrage 3D pour les fiches, qui sont garanties lisibles
   quel que soit l'état de la scène.
   L'image d'ensemble et la fiche "extension gare" sont, elles, de vrais
   rendus 3D : caméra orthographique partagée `orthoCamera`, cadrée sur la
   boîte du polygone d'implantation (jamais sur les objets 3D eux-mêmes,
   pour ne jamais dépendre d'une géométrie qui pourrait fausser le
   cadrage), avec un mini "rig" de projecteurs temporaires (un par face +
   un zénithal) pour un éclairage homogène quelle que soit l'orientation.
   ------------------------------------------------------------ */
let architectModeActive = false;
let architectDir = 'nord';        // 'nord'|'sud'|'est'|'ouest' — axe des élévations et de l'axonométrie
let architectViewMode = 'elevation'; // 'elevation' | 'axo' — ne concerne QUE l'image principale + l'extension gare.
                                      // La vue de haut n'est plus un état exclusif : elle est désormais TOUJOURS
                                      // rendue en vis-à-vis de ce mode (voir composeArchitectSheet / drawArchitectGarePanel).
let architectLabelsOn = true;     // labels visibles sur l'image principale uniquement
// Loupe/main de l'image principale (voir les boutons au survol, plus bas) :
// `zoom` ≥ 1, `cx`/`cy` = décalage du centre de vue en fraction de la demi-
// largeur/demi-hauteur du cadrage non zoomé (0,0 = centré).
const architectViewAdjust = { zoom:1, cx:0, cy:0 };
// Géométrie (en pixels écran) de la dernière composition affichée : sert au
// placement des boutons au survol et au redessin partiel de l'image principale.
let architectLayout = null;
const btnArchitectMode = document.getElementById('btn-architect-mode');
const architectCloseBar = document.getElementById('architect-close-bar');
const btnArchitectClose = document.getElementById('btn-architect-close');
const architectModeBar = document.getElementById('architect-mode-bar');
const architectCanvas = document.getElementById('architect-canvas');
const architectCtx = architectCanvas.getContext('2d');
const architectBtnLabels = document.getElementById('architect-toggle-labels');
const architectBtnExport = document.getElementById('architect-btn-export');
const ARCHITECT_VIEW_DIRS = CameraSkyline.SKYLINE_VIEW_DIRS; // même convention (Nord réel = -Z), voir plus haut
const ARCHITECT_DIR_LABELS = { nord:'NORD', sud:'SUD', est:'EST', ouest:'OUEST' };

let architectSavedState = null;
function enterArchitectMode(){
  if(architectModeActive) return;
  if(getPedestrianModeActive()) exitPedestrianMode();
  if(getGlobalViewActive()) exitGlobalView();
  if(drawing) cancelDraw();
  if(drawMenuOpen) closeDrawMenu();
  if(treePlacing) stopTreeTool();
  if(amenagementPlacing) stopAmenagementsTool();
  if(grassPainting) stopGrassTool();
  if(labelPlacing) stopLabelTool();
  if(editingBuildingId) stopEditBuildingShape();
  if(getMovingBuildingId()) stopMoveBuilding();
  ExtGare.cancelExtensionGareIfActive();
  closeBldgEditWindow();
  resetArchitectViewAdjust();
  // Sauvegarde COMPLÈTE de la caméra perspective + OrbitControls, AVANT
  // toute manipulation — un retour exact à la sortie (voir exitArchitectMode)
  // suppose de capturer tout ce qui peut varier, pas seulement position et
  // cible : quaternion (au cas où une composition intermédiaire l'aurait
  // modifié via lookAt), fov (Vue Globale peut le changer), et les
  // contraintes d'OrbitControls (enabled, min/maxPolarAngle, min/maxDistance).
  architectSavedState = {
    planViewWasActive: planViewActive,
    camPos: camera.position.clone(),
    camQuat: camera.quaternion.clone(),
    camUp: camera.up.clone(),
    camFov: camera.fov,
    camZoom: camera.zoom,
    target: controls.target.clone(),
    controlsEnabled: controls.enabled,
    controlsMinPolar: controls.minPolarAngle,
    controlsMaxPolar: controls.maxPolarAngle,
    controlsMinDist: controls.minDistance,
    controlsMaxDist: controls.maxDistance,
  };
  // Sortie PROPRE de la vue plan si elle était active — via togglePlanView()
  // (restaure la position/cible/contraintes d'avant la vue plan et remet le
  // bouton #btn-plan-view en cohérence), plutôt qu'un simple `planViewActive
  // = false` qui laissait le bouton actif et `planViewSaved` dans un état
  // intermédiaire incohérent.
  if(planViewActive) togglePlanView();
  architectModeActive = true;
  document.body.classList.add('architect-mode');
  btnArchitectMode.classList.add('active');
  setArchitectActiveButtons();
  renderArchitectComposition();
  window.addEventListener('resize', scheduleArchitectRecompose);
}
function exitArchitectMode(){
  if(!architectModeActive) return;
  architectModeActive = false;
  document.body.classList.remove('architect-mode');
  architectCloseBar.classList.remove('show');
  btnArchitectMode.classList.remove('active');
  window.removeEventListener('resize', scheduleArchitectRecompose);
  if(architectSavedState){
    // Re-entrée PROPRE en vue plan si elle était active — via
    // togglePlanView() (remet le bouton #btn-plan-view en cohérence et
    // recalcule `planViewSaved`), puis on écrase sa position hard-codée
    // (dist=160) par la valeur exacte sauvegardée juste après, pour un
    // retour au pixel près plutôt qu'un cadrage approximatif.
    if(architectSavedState.planViewWasActive && !planViewActive) togglePlanView();
    camera.position.copy(architectSavedState.camPos);
    camera.quaternion.copy(architectSavedState.camQuat);
    camera.up.copy(architectSavedState.camUp);
    camera.fov = architectSavedState.camFov;
    camera.zoom = architectSavedState.camZoom;
    camera.updateProjectionMatrix();
    controls.target.copy(architectSavedState.target);
    controls.enabled = architectSavedState.controlsEnabled;
    controls.minPolarAngle = architectSavedState.controlsMinPolar;
    controls.maxPolarAngle = architectSavedState.controlsMaxPolar;
    controls.minDistance = architectSavedState.controlsMinDist;
    controls.maxDistance = architectSavedState.controlsMaxDist;
    controls.update();
  }
  architectSavedState = null;
  // Filet de sécurité : composeArchitectSheet() et renderArchitectPanelCanvas()
  // restaurent déjà symétriquement tout ce qu'ils mutent (render target,
  // viewport, scissor — voir leurs try/finally et sauvegardes en tête de
  // fonction), mais si jamais une composition précédente a planté avant que
  // sa restauration ait pu s'exécuter, on garantit ici que le rendu normal
  // reprend dans un état sain.
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  orthoCamera.up.set(0,1,0);
  controls.enabled = true;
  architectLayout = null;
  resetArchitectViewAdjust();
  architectZoomTools.classList.remove('show');
  // Sécurité éclairage : la planche a modifié temporairement lumières, ombres,
  // exposition et matériaux du site — on resynchronise explicitement tout
  // l'éclairage (jour/nuit, fenêtres allumées, lampadaires) sur l'état courant.
  refreshNightLighting();
}
btnArchitectMode.addEventListener('click', ()=> architectModeActive ? exitArchitectMode() : enterArchitectMode());
btnArchitectClose.addEventListener('click', exitArchitectMode);
window.addEventListener('keydown', (ev)=>{ if(ev.key==='Escape' && architectModeActive) exitArchitectMode(); });
window.addEventListener('mousemove', (ev)=>{
  if(!architectModeActive) return;
  if(ev.clientY <= 6) architectCloseBar.classList.add('show');
  else if(ev.clientY > 90) architectCloseBar.classList.remove('show');
});

function setArchitectActiveButtons(){
  architectModeBar.querySelectorAll('[data-architect-dir]').forEach(btn=>{
    const d = btn.dataset.architectDir;
    if(d==='axo') btn.classList.toggle('active', architectViewMode==='axo');
    else btn.classList.toggle('active', d===architectDir); // la direction reste affichée active quel que soit le mode (élévation ou axo)
  });
  architectBtnLabels.classList.toggle('active', architectLabelsOn);
}
architectModeBar.querySelectorAll('[data-architect-dir]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const d = btn.dataset.architectDir;
    // Le zoom/déplacement de l'image principale est propre à une orientation :
    // on repart d'un cadrage complet à chaque changement de vue.
    resetArchitectViewAdjust();
    if(d==='axo') architectViewMode = (architectViewMode==='axo') ? 'elevation' : 'axo';
    // Nord/Sud/Est/Ouest ne fait plus que tourner l'axe — le mode en cours
    // (élévation ou axonométrie) reste actif, plus besoin de recliquer dessus.
    // La vue de haut correspondante est rendue automatiquement en vis-à-vis,
    // il n'y a donc plus de bouton dédié à activer/désactiver pour elle.
    else { architectDir = d; }
    setArchitectActiveButtons();
    renderArchitectComposition();
  });
});
architectBtnLabels.addEventListener('click', ()=>{
  architectLabelsOn = !architectLabelsOn;
  setArchitectActiveButtons();
  renderArchitectComposition();
});
architectBtnExport.addEventListener('click', ()=> exportArchitectComposition());

/* ---- Loupe + / loupe − / main : au survol de l'image principale
   ("ENSEMBLE — POLYGONE D'IMPLANTATION"), trois boutons permettent
   d'agrandir la vue À L'INTÉRIEUR de l'image (le cadre, lui, ne bouge pas) et
   de la recentrer en la faisant glisser. Seule cette image est redessinée
   (voir redrawArchitectMainLeft), pas toute la planche. ---- */
const architectZoomTools = document.getElementById('architect-zoom-tools');
const architectZoomInBtn = document.getElementById('architect-zoom-in');
const architectZoomOutBtn = document.getElementById('architect-zoom-out');
const architectPanBtn = document.getElementById('architect-pan');
const ARCHITECT_ZOOM_STEP = 1.5;
const ARCHITECT_ZOOM_MAX = 8;
let architectPanToolOn = false;
let architectPanDrag = null; // { startX, startY, cx, cy }
let architectMainRedrawQueued = false;
function refreshArchitectZoomButtons(){
  architectZoomInBtn.disabled = architectViewAdjust.zoom >= ARCHITECT_ZOOM_MAX - 0.001;
  architectZoomOutBtn.disabled = architectViewAdjust.zoom <= 1.001;
  architectPanBtn.classList.toggle('active', architectPanToolOn);
}
function resetArchitectViewAdjust(){
  architectViewAdjust.zoom = 1; architectViewAdjust.cx = 0; architectViewAdjust.cy = 0;
  architectPanToolOn = false; architectPanDrag = null;
  architectCanvas.style.cursor = '';
  refreshArchitectZoomButtons();
}
// Le centre de vue ne peut pas sortir du cadrage complet : à zoom z, la
// fenêtre visible fait 1/z du cadre, donc le centre peut s'écarter d'au plus
// (1 − 1/z) de la demi-taille de ce cadre.
function clampArchitectPan(){
  const lim = Math.max(0, 1 - 1/architectViewAdjust.zoom);
  architectViewAdjust.cx = Math.max(-lim, Math.min(lim, architectViewAdjust.cx));
  architectViewAdjust.cy = Math.max(-lim, Math.min(lim, architectViewAdjust.cy));
}
function queueArchitectMainRedraw(){
  if(architectMainRedrawQueued) return;
  architectMainRedrawQueued = true;
  requestAnimationFrame(()=>{ architectMainRedrawQueued = false; redrawArchitectMainLeft(); });
}
function setArchitectZoom(z){
  architectViewAdjust.zoom = Math.max(1, Math.min(ARCHITECT_ZOOM_MAX, z));
  clampArchitectPan();
  refreshArchitectZoomButtons();
  queueArchitectMainRedraw();
}
architectZoomInBtn.addEventListener('click', ()=> setArchitectZoom(architectViewAdjust.zoom * ARCHITECT_ZOOM_STEP));
architectZoomOutBtn.addEventListener('click', ()=> setArchitectZoom(architectViewAdjust.zoom / ARCHITECT_ZOOM_STEP));
architectPanBtn.addEventListener('click', ()=>{
  architectPanToolOn = !architectPanToolOn;
  architectPanDrag = null;
  architectCanvas.style.cursor = '';
  refreshArchitectZoomButtons();
});
function architectPointInMainLeft(clientX, clientY){
  if(!architectLayout) return false;
  const r = architectLayout.mainRectLeft;
  return clientX >= r.x && clientX <= r.x + r.w && clientY >= r.y && clientY <= r.y + r.h;
}
// Boutons visibles uniquement au survol de l'image principale, calés dans son
// coin bas-droit (le coin haut-gauche porte déjà son titre, et le haut est
// en partie recouvert par la barre d'orientation).
function updateArchitectZoomToolsVisibility(clientX, clientY){
  const show = architectModeActive && (!!architectPanDrag || architectPointInMainLeft(clientX, clientY));
  if(show && architectLayout){
    const r = architectLayout.mainRectLeft;
    architectZoomTools.style.right = Math.round(window.innerWidth - (r.x + r.w) + 10) + 'px';
    architectZoomTools.style.bottom = Math.round(window.innerHeight - (r.y + r.h) + 10) + 'px';
  }
  architectZoomTools.classList.toggle('show', show);
}
window.addEventListener('mousemove', (ev)=> updateArchitectZoomToolsVisibility(ev.clientX, ev.clientY));
architectCanvas.addEventListener('pointerdown', (ev)=>{
  if(!architectModeActive || !architectPanToolOn || ev.button !== 0) return;
  if(!architectPointInMainLeft(ev.clientX, ev.clientY)) return;
  architectPanDrag = { startX: ev.clientX, startY: ev.clientY, cx: architectViewAdjust.cx, cy: architectViewAdjust.cy };
  architectCanvas.setPointerCapture(ev.pointerId);
  architectCanvas.style.cursor = 'grabbing';
  ev.preventDefault();
});
architectCanvas.addEventListener('pointermove', (ev)=>{
  if(!architectModeActive) return;
  if(architectPanDrag){
    const r = architectLayout.mainRectLeft;
    const z = architectViewAdjust.zoom;
    // Le contenu suit la souris : le centre de vue part à l'opposé.
    architectViewAdjust.cx = architectPanDrag.cx - (ev.clientX - architectPanDrag.startX) * (2/z) / r.w;
    architectViewAdjust.cy = architectPanDrag.cy + (ev.clientY - architectPanDrag.startY) * (2/z) / r.h;
    clampArchitectPan();
    queueArchitectMainRedraw();
    return;
  }
  architectCanvas.style.cursor = (architectPanToolOn && architectPointInMainLeft(ev.clientX, ev.clientY)) ? 'grab' : '';
});
function endArchitectPanDrag(ev){
  if(!architectPanDrag) return;
  architectPanDrag = null;
  if(ev && architectCanvas.hasPointerCapture && architectCanvas.hasPointerCapture(ev.pointerId)) architectCanvas.releasePointerCapture(ev.pointerId);
  architectCanvas.style.cursor = (ev && architectPanToolOn && architectPointInMainLeft(ev.clientX, ev.clientY)) ? 'grab' : '';
}
architectCanvas.addEventListener('pointerup', endArchitectPanDrag);
architectCanvas.addEventListener('pointercancel', endArchitectPanDrag);
refreshArchitectZoomButtons();

let architectRecomposeTimer = null;
function scheduleArchitectRecompose(){
  if(!architectModeActive) return;
  clearTimeout(architectRecomposeTimer);
  architectRecomposeTimer = setTimeout(renderArchitectComposition, 150);
}

/* ---- Isolation d'objets dans worldRoot (pour "gare seule") ---- */
function architectIsolateChildren(keepSet){
  const saved = [];
  worldRoot.children.forEach(c=>{
    if(!keepSet.has(c) && c.visible){ saved.push(c); c.visible = false; }
  });
  return saved;
}
function architectRestore(saved){ saved.forEach(c=> c.visible = true); }
function architectIsolateSubtree(target){
  const saved = [];
  let forced = null;
  let node = target;
  while(node && node.parent){
    const parent = node.parent;
    parent.children.forEach(sib=>{
      if(sib!==node && sib.visible){ saved.push(sib); sib.visible = false; }
    });
    if(parent === worldRoot) break;
    node = parent;
  }
  if(!target.visible){ forced = target; target.visible = true; }
  return { saved, forced };
}
function architectRestoreSubtree(state){
  state.saved.forEach(o=> o.visible = true);
  if(state.forced) state.forced.visible = false;
}

/* ---- Éclairage : un petit "studio" de projecteurs temporaires (un par
   face cardinale + un zénithal), en plus d'une ambiance renforcée et d'une
   exposition relevée — garantit une façade toujours lisible quelle que
   soit l'orientation de la caméra, sans dépendre du réglage jour/nuit en
   cours. Le soleil principal (`sun`) est en plus repositionné et son
   ombre portée réactivée : c'est la SEULE source d'ombre en Mode
   Architecte, et elle ne concerne que les nouveaux bâtiments (voir
   architectDisableShadowCasting ci-dessous) — le site existant ne projette
   plus d'ombre, pour concentrer l'attention sur le projet (Référence A/E).
   Tout est retiré/restauré juste après les rendus de la planche. ---- */
let architectStudioGroup = null;
function architectDisableShadowCasting(root){
  const stash = [];
  if(!root) return stash;
  root.traverse(o=>{ if(o.isMesh && o.castShadow){ stash.push(o); o.castShadow = false; } });
  return stash;
}
function architectRestoreShadowCasting(stash){ (stash||[]).forEach(o=> o.castShadow = true); }
function architectSetupLighting(box){
  const state = {
    sunIntensity: sun.intensity,
    sunPos: sun.position.clone(),
    sunTargetPos: sun.target.position.clone(),
    hemiIntensity: hemiLight.intensity,
    hemiColor: hemiLight.color.getHex(),
    hemiGround: hemiLight.groundColor.getHex(),
    shadowsEnabled: renderer.shadowMap.enabled,
    exposure: renderer.toneMappingExposure,
    shadowCam: {
      left: sun.shadow.camera.left, right: sun.shadow.camera.right,
      top: sun.shadow.camera.top, bottom: sun.shadow.camera.bottom,
      far: sun.shadow.camera.far,
    },
  };
  hemiLight.intensity = 1.4;
  hemiLight.color.setHex(0xffffff);
  hemiLight.groundColor.setHex(0xb7bec3);
  renderer.toneMappingExposure = 1.15;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const diag = Math.max(size.x, size.z, 30);

  // Direction d'éclairage cohérente pour toutes les vues Architecte (façon
  // plan de présentation, nord-ouest) — cadrée pour couvrir toute la boîte.
  const sunDir = new THREE.Vector3(-0.5, 1, -0.35).normalize();
  sun.intensity = 1.1;
  sun.position.copy(center).addScaledVector(sunDir, diag*1.3 + 40);
  sun.target.position.copy(center);
  sun.target.updateMatrixWorld();
  sun.shadow.camera.left = -diag*0.75; sun.shadow.camera.right = diag*0.75;
  sun.shadow.camera.top = diag*0.75; sun.shadow.camera.bottom = -diag*0.75;
  sun.shadow.camera.far = diag*3 + size.y + 60;
  sun.shadow.camera.updateProjectionMatrix();
  renderer.shadowMap.enabled = true;

  const rigDirs = [
    new THREE.Vector3(0,0.15,1), new THREE.Vector3(0,0.15,-1),
    new THREE.Vector3(1,0.15,0), new THREE.Vector3(-1,0.15,0),
    new THREE.Vector3(0.15,1,0.15),
  ];
  const group = new THREE.Group();
  rigDirs.forEach(d=>{
    const l = new THREE.DirectionalLight(0xffffff, 0.32);
    l.position.copy(center).addScaledVector(d.normalize(), diag*1.6 + 40);
    l.target.position.copy(center);
    group.add(l); group.add(l.target);
  });
  scene.add(group);
  architectStudioGroup = group;

  // Ombres réservées aux nouveaux bâtiments : le site existant (siteRoot,
  // et globalRoot si visible) ne projette plus d'ombre le temps du rendu.
  const shadowStash = architectDisableShadowCasting(siteRoot);
  if(globalRoot && globalRoot.visible) shadowStash.push(...architectDisableShadowCasting(globalRoot));
  state.shadowStash = shadowStash;
  return state;
}
function architectRestoreLighting(state){
  sun.intensity = state.sunIntensity;
  sun.position.copy(state.sunPos);
  sun.target.position.copy(state.sunTargetPos);
  sun.target.updateMatrixWorld();
  sun.shadow.camera.left = state.shadowCam.left; sun.shadow.camera.right = state.shadowCam.right;
  sun.shadow.camera.top = state.shadowCam.top; sun.shadow.camera.bottom = state.shadowCam.bottom;
  sun.shadow.camera.far = state.shadowCam.far;
  sun.shadow.camera.updateProjectionMatrix();
  hemiLight.intensity = state.hemiIntensity;
  hemiLight.color.setHex(state.hemiColor);
  hemiLight.groundColor.setHex(state.hemiGround);
  renderer.shadowMap.enabled = state.shadowsEnabled;
  renderer.toneMappingExposure = state.exposure;
  if(architectStudioGroup){ scene.remove(architectStudioGroup); architectStudioGroup = null; }
  architectRestoreShadowCasting(state.shadowStash);
}
// Végétation désaturée : feuillage en vert très pâle, troncs en gris —
// donnent l'échelle sans jamais écraser la couleur des nouveaux bâtiments
// (Référence A). Distinction feuillage/tronc par heuristique de teinte
// (le canal vert domine -> feuillage), sans dépendre d'une convention de
// nommage du modèle.
function architectSetTreesTransparent(){
  const mats = new Set();
  treesGroup.traverse(o=>{
    if(!o.isMesh) return;
    (Array.isArray(o.material)?o.material:[o.material]).forEach(m=> m && mats.add(m));
  });
  const saved = [];
  mats.forEach(m=>{
    const prevColor = m.color ? m.color.getHex() : null;
    saved.push([m, m.transparent, m.opacity, prevColor]);
    m.transparent = true; m.opacity = 0.92;
    if(m.color){
      const isFoliage = m.color.g >= m.color.r && m.color.g >= m.color.b;
      m.color.setHex(isFoliage ? 0xc8d8c0 : 0x8f8378);
    }
  });
  return saved;
}
function architectRestoreTrees(saved){
  saved.forEach(([m,t,o,c])=>{ m.transparent = t; m.opacity = o; if(c!==null && m.color) m.color.setHex(c); });
}
// Désaturation du site existant (Référence A/E) : chaque matériau est
// cloné-modifié en place (pas de nouveau matériau créé, pour rester léger
// et pouvoir restaurer exactement l'état précédent via un stash). Un vrai
// gris désaturé calculé depuis la luminance d'origine, pas un blanc plat —
// laisse deviner la matière d'origine tout en la rendant fantomatique.
function architectApplyGrayscale(){
  const stash = new Map();
  function processRoot(root){
    if(!root) return;
    root.traverse(o=>{
      if(!o.isMesh) return;
      (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{
        if(!m || stash.has(m)) return;
        stash.set(m, {
          color: m.color ? m.color.getHex() : null,
          emissive: m.emissive ? m.emissive.getHex() : null,
          opacity: m.opacity, transparent: m.transparent,
        });
        if(m.color){
          const lum = (m.color.r*0.299 + m.color.g*0.587 + m.color.b*0.114);
          const g = 0.62 + lum*0.34; // gris clair, jamais blanc pur ni trop sombre
          m.color.setRGB(g, g, g*0.99);
        }
        if(m.emissive) m.emissive.setHex(0x000000);
        m.transparent = true;
        m.opacity = Math.min(m.opacity===undefined?1:m.opacity, 0.9);
      });
    });
  }
  processRoot(siteRoot);
  if(globalRoot && globalRoot.visible) processRoot(globalRoot);
  return stash;
}
function architectRestoreGrayscale(stash){
  stash.forEach((state, m)=>{
    if(state.color!==null) m.color.setHex(state.color);
    if(state.emissive!==null && m.emissive) m.emissive.setHex(state.emissive);
    m.opacity = state.opacity;
    m.transparent = state.transparent;
  });
}
// Nouveaux bâtiments : usage colors TOUJOURS actifs en Mode Architecte
// (quel que soit legendEnabled — c'est le cœur du mode), + contour noir
// épais sur les arêtes vives pour bien détacher la silhouette (Réf. E).
// On ne touche jamais legendEnabled/rebuildAll : chaque face de bâtiment
// porte déjà son usage dans userData (voir rebuildMesh), donc on peut
// recolorer directement les matériaux (clonés par bâtiment, jamais
// partagés) sans effet de bord sur les bâtiments "de départ" (depart.json).
function architectApplyUsageColors(){
  const stash = new Map();
  const edgesAdded = [];
  architectNewBuildings().forEach(b=>{
    b.group.children.slice().forEach(o=>{
      if(!o.isMesh || !o.userData || !o.userData.isVolumeFace) return;
      const m = o.material;
      if(m && !stash.has(m)){
        stash.set(m, {
          color: m.color ? m.color.getHex() : null,
          emissive: m.emissive ? m.emissive.getHex() : null,
          opacity: m.opacity, transparent: m.transparent,
          roughness: m.roughness, metalness: m.metalness,
        });
        const usage = o.userData.usage || 'nondefini';
        const hex = (USAGE_COLORS[usage]!==undefined) ? USAGE_COLORS[usage] : 0x999999;
        if(m.color) m.color.setHex(hex);
        if(m.emissive) m.emissive.setHex(0x000000);
        m.transparent = false; m.opacity = 1.0;
        if('roughness' in m) m.roughness = 0.78;
        if('metalness' in m) m.metalness = 0.04;
      }
      const edges = new THREE.EdgesGeometry(o.geometry, 25);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x0a0a0a }));
      line.position.copy(o.position);
      line.renderOrder = 50;
      b.group.add(line);
      edgesAdded.push({ group:b.group, line });
    });
  });
  return { stash, edgesAdded };
}
function architectRestoreUsageColors(saved){
  saved.stash.forEach((state, m)=>{
    if(state.color!==null) m.color.setHex(state.color);
    if(state.emissive!==null && m.emissive) m.emissive.setHex(state.emissive);
    m.opacity = state.opacity; m.transparent = state.transparent;
    if(state.roughness!==undefined) m.roughness = state.roughness;
    if(state.metalness!==undefined) m.metalness = state.metalness;
  });
  saved.edgesAdded.forEach(({group,line})=>{
    group.remove(line); line.geometry.dispose(); line.material.dispose();
  });
}

/* ---- Rendu 3D d'un panneau (image d'ensemble ou extension gare) dans une
   cible hors-écran, lu en canvas 2D. `viewMode` = 'elevation'|'haut'|'axo'. ---- */
let architectRT = null;
function ensureArchitectRT(w, h){
  w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
  if(architectRT && architectRT.width===w && architectRT.height===h) return architectRT;
  if(architectRT) architectRT.dispose();
  architectRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer:true, stencilBuffer:false });
  return architectRT;
}
function architectRTToCanvas(target, w, h){
  w = Math.round(w); h = Math.round(h);
  const buffer = new Uint8Array(w*h*4);
  renderer.readRenderTargetPixels(target, 0, 0, w, h, buffer);
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const cctx = cnv.getContext('2d');
  const imgData = cctx.createImageData(w, h);
  for(let y=0; y<h; y++){
    const srcStart = (h-1-y)*w*4;
    imgData.data.set(buffer.subarray(srcStart, srcStart+w*4), y*w*4);
  }
  cctx.putImageData(imgData, 0, 0);
  return cnv;
}
const ARCHITECT_BG = 0xf2f0ea;
/* ---- Cadrage : `frameArchitectCamera` positionne toujours `orthoCamera`
   (nécessaire au rendu WebGL lui-même), MAIS retourne en plus un objet
   `framing` 100% en données pures (Vector3/nombres, jamais de référence
   Three.js mutable) qui décrit exactement cette prise de vue. C'est CET
   objet — jamais `orthoCamera` directement — qui doit servir à toute
   projection ultérieure (numéros, labels, cotes, grille), pour ne jamais
   dépendre d'une caméra partagée qui sera re-cadrée par le panneau suivant
   (fiche "Extension Gare", etc.). ---- */
function frameArchitectCamera(box, dir, viewMode, aspect, marginFactor, viewAdjust){
  const margin = marginFactor || 1.0;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const diag = Math.max(size.x, size.y, size.z, 10);
  if(viewMode === 'haut'){
    const standoff = size.y + 100;
    orthoCamera.position.set(center.x, box.max.y + standoff, center.z);
    // Vue de haut cohérente avec l'élévation choisie : on regarde depuis la
    // même face (Nord = caméra au Nord, qui regarde vers le Sud), donc cette
    // face se retrouve EN BAS de l'image, exactement comme l'observateur de
    // l'élévation — et la gauche/droite de l'élévation reste la gauche/droite
    // du plan. (Avant : `-viewDir`, qui retournait le plan de 180° — Nord/Sud
    // et Est/Ouest inversés par rapport à l'élévation affichée à côté.)
    const upDir = ARCHITECT_VIEW_DIRS[dir];
    orthoCamera.up.set(upDir.x, 0, upDir.z);
    orthoCamera.lookAt(center);
    let halfW = Math.max(size.x, size.z, 10) * margin / 2;
    let halfH = halfW;
    if(halfW/halfH < aspect) halfW = halfH*aspect; else halfH = halfW/aspect;
    orthoCamera.left=-halfW; orthoCamera.right=halfW; orthoCamera.top=halfH; orthoCamera.bottom=-halfH;
    orthoCamera.near = 0.5; orthoCamera.far = standoff*2 + size.y + 40;
  } else if(viewMode === 'axo'){
    const elev = THREE.MathUtils.degToRad(32);
    const horiz = ARCHITECT_VIEW_DIRS[dir].clone().multiplyScalar(-1);
    const camDir = new THREE.Vector3(horiz.x*Math.cos(elev), Math.sin(elev), horiz.z*Math.cos(elev)).normalize();
    const standoff = diag*1.4 + 60;
    orthoCamera.position.copy(center).addScaledVector(camDir, standoff);
    orthoCamera.up.set(0,1,0);
    orthoCamera.lookAt(center);
    // Étendue réellement nécessaire à l'écran : le plan (X/Z) reste la
    // référence — jamais la hauteur brute d'une tour isolée, qui gonflait
    // artificiellement le cadrage (et donc le vide en haut/bas) dès qu'un
    // bâtiment dépassait largement l'emprise au sol. La hauteur n'ajoute
    // que sa projection apparente sous l'angle de vue (sin(elev)).
    const footprintExtent = Math.max(size.x, size.z, 10);
    const apparentHeight = size.y * Math.sin(elev);
    let halfW = footprintExtent * margin / 2;
    let halfH = Math.max(footprintExtent, apparentHeight * 1.15) * margin / 2;
    if(halfW/halfH < aspect) halfW = halfH*aspect; else halfH = halfW/aspect;
    orthoCamera.left=-halfW; orthoCamera.right=halfW; orthoCamera.top=halfH; orthoCamera.bottom=-halfH;
    orthoCamera.near = 0.5; orthoCamera.far = standoff*2 + diag;
  } else {
    const viewDir = ARCHITECT_VIEW_DIRS[dir];
    const horizExtent = Math.abs(viewDir.x) > 0.5 ? size.z : size.x;
    const depthExtent  = Math.abs(viewDir.x) > 0.5 ? size.x : size.z;
    const vertExtent = Math.max(size.y, 3);
    const standoff = Math.max(depthExtent, 10) + 100;
    orthoCamera.position.copy(center).addScaledVector(viewDir, -(depthExtent/2 + standoff));
    orthoCamera.up.set(0,1,0);
    orthoCamera.lookAt(center);
    let halfW = Math.max(horizExtent, 6) * margin / 2;
    let halfH = Math.max(vertExtent, 6) * margin / 2;
    if(halfW/halfH < aspect) halfW = halfH*aspect; else halfH = halfW/aspect;
    orthoCamera.left = -halfW; orthoCamera.right = halfW; orthoCamera.top = halfH; orthoCamera.bottom = -halfH;
    orthoCamera.near = standoff*0.5; orthoCamera.far = depthExtent + standoff*1.5;
  }
  // Loupe / main (image principale uniquement) : zoom = rétrécissement de la
  // fenêtre de vue, pan = translation de la caméra ET de sa cible dans le
  // plan de l'image (jamais en profondeur, donc near/far restent valides et
  // l'orientation ne change pas). `cx`/`cy` sont exprimés en fraction de la
  // demi-largeur/demi-hauteur du cadrage non zoomé. Le `framing` retourné
  // décrit la vue zoomée/déplacée : numéros, labels, grille et cotes suivent.
  if(viewAdjust && viewAdjust.zoom > 1.0001){
    const z = viewAdjust.zoom;
    const halfW0 = (orthoCamera.right - orthoCamera.left) / 2;
    const halfH0 = (orthoCamera.top - orthoCamera.bottom) / 2;
    orthoCamera.updateMatrixWorld(true);
    const camRight = new THREE.Vector3().setFromMatrixColumn(orthoCamera.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(orthoCamera.matrixWorld, 1);
    const shift = camRight.multiplyScalar((viewAdjust.cx||0) * halfW0).addScaledVector(camUp, (viewAdjust.cy||0) * halfH0);
    orthoCamera.position.add(shift);
    center.add(shift);
    orthoCamera.left = -halfW0 / z; orthoCamera.right = halfW0 / z;
    orthoCamera.top = halfH0 / z; orthoCamera.bottom = -halfH0 / z;
  }
  orthoCamera.updateProjectionMatrix();
  const framing = {
    center: center.clone(),
    camPos: orthoCamera.position.clone(),
    up: orthoCamera.up.clone(),
    halfW: (orthoCamera.right - orthoCamera.left) / 2,
    halfH: (orthoCamera.top - orthoCamera.bottom) / 2,
    viewMode, dir,
    near: orthoCamera.near, far: orthoCamera.far,
  };
  return { center, framing };
}
// Reproduit à la main la projection orthographique d'un `framing` figé —
// jamais via `orthoCamera` (qui a pu être recadrée depuis). Retourne aussi
// les coordonnées NDC (utiles pour rejeter un point hors cadre) et la
// profondeur (utile pour trier par éloignement).
function projectWorldToMainRect(worldVec3, framing, rect){
  if(!framing) return { x:0, y:0, ndcX:2, ndcY:2, depth:-1, visible:false };
  const forward = new THREE.Vector3().subVectors(framing.center, framing.camPos).normalize();
  const right = new THREE.Vector3().crossVectors(forward, framing.up).normalize();
  const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  const rel = new THREE.Vector3().subVectors(worldVec3, framing.camPos);
  const depth = rel.dot(forward);
  const ndcX = rel.dot(right) / framing.halfW;
  const ndcY = rel.dot(camUp) / framing.halfH;
  const visible = depth > 0 && Math.abs(ndcX) <= 1.1 && Math.abs(ndcY) <= 1.1;
  return {
    x: rect.x + (ndcX*0.5+0.5)*rect.w,
    y: rect.y + (1-(ndcY*0.5+0.5))*rect.h,
    ndcX, ndcY, depth, visible,
  };
}
// Angle (radians) pour orienter un glyphe dessiné "pointant vers le haut"
// par défaut de sorte qu'il pointe vers le Nord réel (-Z, convention du
// projet) tel qu'il apparaît projeté dans ce `framing`.
function architectNorthArrowAngle(framing){
  if(!framing) return 0;
  const forward = new THREE.Vector3().subVectors(framing.center, framing.camPos).normalize();
  const right = new THREE.Vector3().crossVectors(forward, framing.up).normalize();
  const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  const north = new THREE.Vector3(0,0,-1);
  const sx = north.dot(right), sy = -north.dot(camUp);
  return Math.atan2(sx, -sy);
}
function renderArchitectPanelCanvas(box, dir, viewMode, pxW, pxH, marginFactor, viewAdjust){
  const w = Math.max(48, Math.round(pxW)), h = Math.max(48, Math.round(pxH));
  const rt = ensureArchitectRT(w, h);

  // Sauvegarde COMPLÈTE et symétrique de l'état de rendu courant (jamais de
  // reconstruction à la main à partir de domElement.width/height).
  const prevTarget = renderer.getRenderTarget();
  const prevViewport = new THREE.Vector4();
  renderer.getViewport(prevViewport);
  const prevScissor = new THREE.Vector4();
  renderer.getScissor(prevScissor);
  const prevScissorTest = renderer.getScissorTest();
  const prevBg = scene.background;
  const prevClearColor = new THREE.Color(); renderer.getClearColor(prevClearColor);
  const prevClearAlpha = renderer.getClearAlpha();

  scene.background = null;
  renderer.setClearColor(ARCHITECT_BG, 1);
  const { center, framing } = frameArchitectCamera(box, dir, viewMode, w/h, marginFactor, viewAdjust);

  renderer.setRenderTarget(rt);
  // IMPORTANT : `setViewport`/`setScissor` attendent des dimensions en
  // pixels LOGIQUES (CSS), pas des pixels de buffer — le renderer multiplie
  // toujours par son pixelRatio courant avant de transmettre à gl.viewport().
  // On force temporairement le pixelRatio à 1 pour que 1 unité passée ici
  // corresponde exactement à 1 pixel de la render target `rt` (qui fait
  // exactement w × h, sans notion de pixelRatio) — sinon, sur un écran
  // Retina/HiDPI, le viewport réel dépasserait la RT et son contenu
  // apparaîtrait rogné/zoomé dans les vignettes. Restauré juste après le
  // rendu, avant tout autre rendu (y compris celui de la boucle animate()).
  const prevPixelRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);
  renderer.setScissorTest(true);
  renderer.clear(true, true, false);
  renderer.render(scene, orthoCamera);
  renderer.setPixelRatio(prevPixelRatio);

  const cnv = architectRTToCanvas(rt, w, h);

  // Restauration symétrique de tout ce qui a été sauvegardé plus haut.
  renderer.setRenderTarget(prevTarget);
  renderer.setViewport(prevViewport);
  renderer.setScissor(prevScissor);
  renderer.setScissorTest(prevScissorTest);
  scene.background = prevBg;
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  let groundY;
  if(viewMode === 'elevation'){
    const g = new THREE.Vector3(center.x, 0, center.z).project(orthoCamera);
    groundY = (1 - (g.y*0.5+0.5)) * h;
  }
  return { cnv, groundY, framing };
}
function architectDrawGroundMask(ctx, rect, imgH, groundY){
  if(groundY===undefined) return;
  const y = rect.y + Math.max(0, Math.min(imgH, groundY));
  if(y >= rect.y + imgH) return;
  ctx.fillStyle = 'rgba(94,100,106,0.88)';
  ctx.fillRect(rect.x, y, rect.w, rect.y+imgH-y);
}
// Grille de fond légère (tous les 10 m / 50 m), projetée au sol (y=0) dans
// le `framing` figé de l'image principale — donne une échelle immédiate,
// comme sur un vrai plan d'architecte (Référence B).
function architectDrawGroundGrid(ctx, rect, framing, box){
  if(!framing) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
  const minX = Math.floor(box.min.x/10)*10, maxX = Math.ceil(box.max.x/10)*10;
  const minZ = Math.floor(box.min.z/10)*10, maxZ = Math.ceil(box.max.z/10)*10;
  for(let x=minX; x<=maxX; x+=10){
    const major = Math.round(x)%50===0;
    ctx.strokeStyle = major ? 'rgba(20,26,30,0.08)' : 'rgba(20,26,30,0.03)';
    ctx.lineWidth = major ? 1 : 0.6;
    const p1 = projectWorldToMainRect(new THREE.Vector3(x,0,minZ), framing, rect);
    const p2 = projectWorldToMainRect(new THREE.Vector3(x,0,maxZ), framing, rect);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
  }
  for(let z=minZ; z<=maxZ; z+=10){
    const major = Math.round(z)%50===0;
    ctx.strokeStyle = major ? 'rgba(20,26,30,0.08)' : 'rgba(20,26,30,0.03)';
    ctx.lineWidth = major ? 1 : 0.6;
    const p1 = projectWorldToMainRect(new THREE.Vector3(minX,0,z), framing, rect);
    const p2 = projectWorldToMainRect(new THREE.Vector3(maxX,0,z), framing, rect);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
  }
  ctx.restore();
}
// Cote linéaire (flèches + valeur en mètres) entre deux points déjà
// projetés à l'écran.
function architectDrawDimensionLine(ctx, p1, p2, text, scale){
  ctx.save();
  ctx.strokeStyle = '#4a5560'; ctx.lineWidth = 1*scale;
  ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
  [[p1,p2],[p2,p1]].forEach(([from,to])=>{
    const ang = Math.atan2(to.y-from.y, to.x-from.x);
    const al = 6*scale;
    ctx.beginPath();
    ctx.moveTo(from.x,from.y);
    ctx.lineTo(from.x+Math.cos(ang-0.4)*al, from.y+Math.sin(ang-0.4)*al);
    ctx.moveTo(from.x,from.y);
    ctx.lineTo(from.x+Math.cos(ang+0.4)*al, from.y+Math.sin(ang+0.4)*al);
    ctx.stroke();
  });
  const mx=(p1.x+p2.x)/2, my=(p1.y+p2.y)/2;
  ctx.font = `500 ${9*scale}px 'IBM Plex Mono', monospace`;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(242,240,234,0.85)';
  ctx.fillRect(mx-tw/2-3*scale, my-12*scale, tw+6*scale, 12*scale);
  ctx.fillStyle = '#20262b';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(text, mx, my-1*scale);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}
// Cotes hors-tout du polygone d'implantation (largeur / profondeur),
// positionnées à l'extérieur du polygone (Réf. B/D).
function architectDrawPolygonDimensions(ctx, rect, framing, box, scale){
  if(!framing || !buildZone || buildZone.length<3) return;
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  buildZone.forEach(p=>{ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); });
  const widthM = maxX-minX, depthM = maxZ-minZ;
  const outOffset = box.getSize(new THREE.Vector3()).x * 0.045;
  const wz = minZ - outOffset;
  const a = projectWorldToMainRect(new THREE.Vector3(minX,0,wz), framing, rect);
  const b2 = projectWorldToMainRect(new THREE.Vector3(maxX,0,wz), framing, rect);
  architectDrawDimensionLine(ctx, a, b2, `${widthM.toFixed(0)} m`, scale);
  const dx = minX - outOffset;
  const c = projectWorldToMainRect(new THREE.Vector3(dx,0,minZ), framing, rect);
  const d = projectWorldToMainRect(new THREE.Vector3(dx,0,maxZ), framing, rect);
  architectDrawDimensionLine(ctx, c, d, `${depthM.toFixed(0)} m`, scale);
}

/* ---- Boîte englobante de l'image principale : englobe systématiquement
   « site réel + nouveaux bâtiments + labels », avec une marge généreuse
   (20 % du côté le plus long) pour que la maquette flotte sur le fond
   blanc sans être collée aux bords (Réf. A/E). Construite à partir de
   données 2D/scalaires fiables — jamais un setFromObject(worldRoot) brut,
   qui peut être faussé par une géométrie annexe (marqueur, sommet
   d'édition...) ailleurs dans la hiérarchie. ---- */
function architectMainBox(){
  const box = new THREE.Box3();
  // Cœur : le polygone d'implantation
  if(buildZone && buildZone.length>=3){
    buildZone.forEach(p=> box.expandByPoint(new THREE.Vector3(p.x, 0, p.z)));
  }
  // Empreintes 2D de TOUS les bâtiments (dépárt.json ET nouveaux)
  buildings.forEach(b=> b.points.forEach(p=> box.expandByPoint(new THREE.Vector3(p.x, 0, p.z))));
  // Positions de tous les labels
  if(typeof labels!=='undefined'){
    labels.forEach(l=> box.expandByPoint(new THREE.Vector3(l.x, l.y!==undefined?l.y:0, l.z)));
  }
  // Éléments structurants du site réel — UNIQUEMENT quartierGroup et
  // hallMesh (jamais worldRoot/siteRoot en entier), pour ne pas polluer
  // avec des géométries parasites.
  if(quartierGroup) box.union(new THREE.Box3().setFromObject(quartierGroup));
  if(hallMesh) box.union(new THREE.Box3().setFromObject(hallMesh));
  if(box.isEmpty()) box.setFromObject(worldRoot);

  // Hauteur de cadrage : un SCALAIRE (pas une bounding-box 3D) — la
  // hauteur du plus haut nouveau bâtiment.
  const maxH = Math.max(20, ...architectNewBuildings().map(b=> buildingTotalHeight(b)), 0);
  box.min.y = Math.min(box.min.y, -5);
  box.max.y = Math.max(box.max.y, maxH);

  // Marge explicite : 12 % du plus long côté en plan, appliquée en X/Z
  // (et une fraction plus modeste encore en hauteur, pour ne pas ajouter de
  // vide superflu au-dessus des bâtiments). Réduite par rapport à la marge
  // d'origine (20 % / ×0.35) : l'image principale flottait avec de grands
  // bandeaux vides en haut et en bas.
  const size = box.getSize(new THREE.Vector3());
  const padding = 0.12 * Math.max(size.x, size.z);
  box.min.x -= padding; box.max.x += padding;
  box.min.z -= padding; box.max.z += padding;
  box.max.y += padding * 0.15;
  return box;
}
function architectNewBuildings(){ return buildings.filter(b=> !b.noRoofInset); }
function architectSortedNewBuildings(){
  return architectNewBuildings().slice().sort((a,b)=> buildingTotalHeight(b) - buildingTotalHeight(a));
}

/* ---- Nomenclature + données de "coupe" (100% calculées, pas de rendu 3D) ---- */
function architectBuildingUsageTotals(b){
  const totals = {};
  b.bands.forEach(band=>{
    const nFloors = Math.max(0, band.to - band.from + 1);
    const area = polygonAreaXZ(footprintForBand(b, band)) * nFloors;
    totals[band.usage] = (totals[band.usage]||0) + area;
  });
  return totals;
}
function architectBuildingSheet(b){
  const totals = architectBuildingUsageTotals(b);
  const usageLines = Object.entries(totals)
    .filter(([,v])=> v > 0.5)
    .sort((a,b2)=> b2[1]-a[1])
    .map(([usage,v])=> ({ label: USAGE_LABELS[usage]||usage, color: USAGE_COLORS[usage]||0x999999, text: `${USAGE_LABELS[usage]||usage} : ${v.toFixed(0)} m²` }));
  return {
    name: b.name,
    height: `${buildingTotalHeight(b).toFixed(1)} m`,
    floors: `${b.floors} niveau${b.floors>1?'x':''}`,
    footprint: `${polygonAreaXZ(b.points).toFixed(0)} m² au sol`,
    developed: `${buildingTotalFloorArea(b).toFixed(0)} m² développés`,
    usageLines,
  };
}
// Un "étage" par ligne, coloré par son usage, largeur en retrait selon
// l'emprise RÉELLE (bounding box, pas une racine carrée d'aire qui perdrait
// le rapport largeur/profondeur) de la bande à laquelle il appartient, vue
// depuis la façade actuellement affichée (`dir`) — comme une vraie coupe.
function architectFootprintCenter(points){
  let sx=0, sz=0;
  points.forEach(p=>{ sx+=p.x; sz+=p.z; });
  return { x: sx/points.length, z: sz/points.length };
}
// Retourne [min,max] de l'emprise d'une bande le long de l'axe visible
// depuis `dir` (X pour Nord/Sud, Z pour Est/Ouest) — sert à dessiner une
// VRAIE silhouette en coupe (retraits asymétriques respectés), pas une
// simple largeur centrée.
function architectFootprintRange(poly, dir){
  let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
  poly.forEach(p=>{ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); });
  const viewDir = ARCHITECT_VIEW_DIRS[dir];
  return Math.abs(viewDir.x) > 0.5 ? [minZ,maxZ] : [minX,maxX];
}
// Silhouette réelle : chaque étage garde le [gauche,droite] réel de sa
// bande (retraits asymétriques respectés), tous alignés sur le même
// centre de référence (la bande la plus large, en général le socle).
function architectBuildingCoupeData(b, dir){
  const bandRange = new Map();
  b.bands.forEach(band=> bandRange.set(band, architectFootprintRange(footprintForBand(b, band), dir)));
  let refCenter = 0, refSpan = 1;
  bandRange.forEach(([mn,mx])=>{ const span = mx-mn; if(span>refSpan){ refSpan = span; refCenter = (mn+mx)/2; } });
  const floors = [];
  let y = 0;
  for(let f=1; f<=b.floors; f++){
    const usage = usageAtFloor(b, f);
    const h = floorHeightFor(usage);
    const band = b.bands.find(bd=> f>=bd.from && f<=bd.to) || b.bands[0];
    const range = band ? bandRange.get(band) : [refCenter-refSpan/2, refCenter+refSpan/2];
    floors.push({ f, usage, h, y, left: range[0]-refCenter, right: range[1]-refCenter });
    y += h;
  }
  return { totalH: y, floors, maxSpan: refSpan };
}
// Assombrit (factor<1) ou éclaircit (factor>1) une couleur hexadécimale —
// sert à l'alternance clair/foncé un étage sur deux d'une même couleur
// d'usage (Référence B).
function architectShadeColor(hex, factor){
  const r = Math.min(255, Math.max(0, Math.round(((hex>>16)&255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((hex>>8)&255) * factor)));
  const bl = Math.min(255, Math.max(0, Math.round((hex&255) * factor)));
  return (r<<16)|(g<<8)|bl;
}
// Vignette "vue en coupe" pour la liste des bâtiments (remplace la pastille
// de couleur unique) : même logique de silhouette réelle empilée par étage
// que la fiche du mode architecte (architectBuildingCoupeData /
// architectShadeColor), juste miniaturisée et sans cotation/nomenclature —
// la vignette EST la légende (couleur = usage, comme le reste de l'appli).
export function drawBldgListCoupeIcon(canvas, b){
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  const coupe = architectBuildingCoupeData(b, 'sud');
  const pxPerM = h / Math.max(1, coupe.totalH);
  const barMaxW = w*0.88;
  const pxPerMw = barMaxW / Math.max(1, coupe.maxSpan);
  const cx = w/2;
  coupe.floors.forEach(fl=>{
    const fh = Math.max(1, fl.h*pxPerM);
    const fy = h - (fl.y+fl.h)*pxPerM;
    const fx = cx + fl.left*pxPerMw;
    const fw = Math.max(2, (fl.right-fl.left)*pxPerMw);
    const baseHex = USAGE_COLORS[fl.usage]!==undefined ? USAGE_COLORS[fl.usage] : 0x999999;
    const shaded = architectShadeColor(baseHex, fl.f%2===0 ? 0.82 : 1.0);
    ctx.fillStyle = `#${shaded.toString(16).padStart(6,'0')}`;
    ctx.fillRect(fx, fy, fw, fh);
  });
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w-1, h-1);
}
// Petit pictogramme d'emprise au sol (forme réelle du polygone du
// bâtiment, à l'échelle) — donnée directement reconstructible depuis
// `b.points`, affichée sur chaque fiche pour montrer la vraie forme.
function architectDrawFootprintIcon(ctx, cx, cy, size, points, scale){
  if(!points || points.length<3) return;
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  points.forEach(p=>{ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); });
  const w = Math.max(1,maxX-minX), d = Math.max(1,maxZ-minZ);
  const s = (size*0.82) / Math.max(w,d);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  points.forEach((p,i)=>{
    const px = (p.x - (minX+maxX)/2)*s;
    const py = (p.z - (minZ+maxZ)/2)*s;
    if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(20,26,30,.09)';
  ctx.fill();
  ctx.strokeStyle = '#20262b'; ctx.lineWidth = 1*scale;
  ctx.stroke();
  ctx.restore();
}

/* ---- Anti-superposition (numéros + labels de l'image principale) : cherche
   une place libre en spirale AUTOUR du point réel, rayon plafonné — jamais
   la fuite en avant d'une poussée verticale sans limite. Au-delà du rayon
   maximum, on accepte un léger chevauchement plutôt que de partir loin
   (`maxRadius` est passé par l'appelant : 60 px pour les pastilles, 30 px
   pour les labels, comme demandé). ---- */
function architectPlaceLabel(placedRects, cx, cy, w, h, maxRadius){
  maxRadius = maxRadius || 60;
  const tries = 24;
  for(let i=0; i<tries; i++){
    const radius = maxRadius * (i/tries);
    const angle = i * 2.399963; // angle d'or : répartit les essais dans toutes les directions
    const x = cx + Math.cos(angle)*radius;
    const y = cy - Math.abs(Math.sin(angle))*radius; // reste toujours au-dessus du point d'origine
    const r = { left:x-w/2, right:x+w/2, top:y-h, bottom:y };
    const overlap = placedRects.some(o=> !(r.right<o.left || r.left>o.right || r.bottom<o.top || r.top>o.bottom));
    if(!overlap){ placedRects.push(r); return { x, y }; }
  }
  const r = { left:cx-w/2, right:cx+w/2, top:cy-h, bottom:cy };
  placedRects.push(r);
  return { x:cx, y:cy };
}
// Dessine un chemin en coude à angle droit (horizontal→vertical) sur un
// contexte Canvas 2D — équivalent de buildElbowPath() mais pour du rendu
// Canvas plutôt qu'un <path> SVG.
function architectDrawElbow(ctx, x1, y1, x2, y2, vertical){
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if(vertical){
    const midY = (y1+y2)/2;
    ctx.lineTo(x1, midY); ctx.lineTo(x2, midY);
  } else {
    const midX = (x1+x2)/2;
    ctx.lineTo(midX, y1); ctx.lineTo(midX, y2);
  }
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
function architectRoundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

/* ------------------------------------------------------------
   COMPOSITION
   ------------------------------------------------------------ */
const ARCHITECT_PAPER = '#f2f0ea';
// Rendu d'UNE des deux images principales (élévation/axo OU vue de haut) +
// toutes ses annotations (grille sol, cotes, numéros de bâtiments, labels
// de la maquette). Extrait dans sa propre fonction pour être appelée deux
// fois côte à côte — la vue de haut n'est plus un état exclusif basculé
// par un bouton, elle est désormais toujours affichée en vis-à-vis de
// l'élévation/axonométrie choisie, puisque la place ne manque pas à l'écran.
function drawArchitectMainView(ctx, rect, mainBox, dir, mode, scale, sortedNew, indexOf, vehiclesWereVisible, tagTxt, viewAdjust){
  setVehiclesVisible((mode==='haut') ? false : vehiclesWereVisible); applyAgentTypeVisibility();
  const globalRootWasVisible = globalRoot.visible;
  globalRoot.visible = false; // seule la maquette du site réel (place_de_milan.glb) est montrée
  let res;
  try{
    res = renderArchitectPanelCanvas(mainBox, dir, mode, rect.w, rect.h, 0.92, viewAdjust);
  } finally {
    globalRoot.visible = globalRootWasVisible;
    setVehiclesVisible(vehiclesWereVisible); applyAgentTypeVisibility();
  }
  const framing = res.framing;

  architectPanelShadow(ctx, rect, scale);
  // Tout ce qui est projeté dans l'image (grille, cotes, numéros, labels) est
  // écrêté au cadre : avec le zoom, ces annotations débordent facilement et
  // ne doivent jamais recouvrir les panneaux voisins.
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
  ctx.drawImage(res.cnv, rect.x, rect.y, rect.w, rect.h);
  if(mode==='elevation') architectDrawGroundMask(ctx, rect, rect.h, res.groundY);
  architectDrawGroundGrid(ctx, rect, framing, mainBox);
  architectDrawPolygonDimensions(ctx, rect, framing, mainBox, scale);

  // Numéros au-dessus de chaque nouveau bâtiment + labels de la maquette,
  // projetés via `framing` (jamais `orthoCamera` directement — il a pu être
  // recadré entre-temps par un rendu ultérieur). `placedRects` est propre à
  // CETTE image : les deux vues côte à côte ne se contraignent pas l'une
  // l'autre pour le placement des étiquettes.
  const placedRects = [];
  sortedNew.forEach(b=>{
    // Ancrage = centroïde 2D des points projetés du toit qui tombent dans
    // le cadre (plus proche du centre visuel réel qu'un simple centre 3D).
    const lastBand = b.bands[b.bands.length-1];
    const footprint = footprintForBand(b, lastBand);
    const roofH = buildingTotalHeight(b);
    const projPts = footprint.map(p=> projectWorldToMainRect(new THREE.Vector3(p.x, roofH, p.z), framing, rect));
    const visiblePts = projPts.filter(p=> p.visible);
    if(!visiblePts.length) return; // rejeté : ancrage hors cadre
    const sx = visiblePts.reduce((s,p)=>s+p.x,0)/visiblePts.length;
    const sy = visiblePts.reduce((s,p)=>s+p.y,0)/visiblePts.length;
    const r = 12*scale; // diamètre ~24px
    const off = 15*scale*Math.SQRT1_2; // décalage par défaut : au-dessus-gauche, 15px
    const idealX = sx - off, idealY = sy - off;
    const pos = architectPlaceLabel(placedRects, idealX, idealY, r*2+6*scale, r*2+6*scale, 60*scale);
    if(Math.hypot(pos.x-sx, pos.y-sy) > r+2*scale){
      ctx.strokeStyle = 'rgba(20,26,30,.7)'; ctx.lineWidth = 0.8*scale;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(pos.x, pos.y); ctx.stroke();
      ctx.fillStyle = '#141a1e';
      ctx.beginPath(); ctx.arc(sx, sy, 2*scale, 0, Math.PI*2); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI*2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = '#141a1e'; ctx.lineWidth = 1.5*scale; ctx.stroke();
    ctx.fillStyle = '#141a1e'; ctx.font = `700 ${11*scale}px 'Space Grotesk', sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(indexOf.get(b)), pos.x, pos.y+0.5*scale);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  });
  if(architectLabelsOn && labels.length){
    ctx.font = `600 ${10.5*scale}px 'Space Grotesk', sans-serif`;
    // Tri par profondeur (les plus proches en premier) : leurs traits de
    // rappel ne seront jamais recouverts par ceux des labels lointains.
    const projected = labels.map(l=>{
      const p = projectWorldToMainRect(new THREE.Vector3(l.x, l.y!==undefined?l.y:0.3, l.z), framing, rect);
      return { l, p };
    }).filter(({p})=> p.visible)
      .sort((a,b2)=> a.p.depth - b2.p.depth);
    projected.forEach(({l,p})=>{
      const sx = p.x, sy = p.y;
      const tw = ctx.measureText(l.text).width;
      const padX = 6*scale, padY = 4*scale;
      const chipW = tw + padX*2, chipH = 10.5*scale + padY*2;
      // Décalage fixe 12px vers le haut-droite, jamais déplacé de plus de
      // 30px de sa position idéale (au-delà : accepter le chevauchement
      // plutôt que de partir loin).
      const idealX = sx + 12*scale + chipW/2, idealY = sy - 12*scale - chipH/2;
      const pos = architectPlaceLabel(placedRects, idealX, idealY, chipW, chipH, 30*scale);
      const chipX = pos.x - chipW/2, chipY = pos.y - chipH/2;
      const vertical = Math.abs(chipX-sx) < Math.abs(chipY-sy);
      ctx.strokeStyle = 'rgba(20,26,30,.5)'; ctx.lineWidth = 1*scale;
      architectDrawElbow(ctx, sx, sy, chipX + (chipX<sx?chipW:0), chipY+chipH/2, vertical);
      // halo sombre derrière la pastille pour lisibilité sur fond clair
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      architectRoundRect(ctx, chipX+1*scale, chipY+1*scale, chipW, chipH, 4*scale); ctx.fill();
      ctx.fillStyle = 'rgba(20,26,30,.85)';
      architectRoundRect(ctx, chipX, chipY, chipW, chipH, 4*scale); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(l.text, chipX+padX, chipY+chipH/2+0.5*scale);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#2ee8ff';
      ctx.beginPath(); ctx.arc(sx, sy, 2.6*scale, 0, Math.PI*2); ctx.fill();
    });
  }
  ctx.restore(); // fin de l'écrêtage au cadre de l'image

  ctx.strokeStyle = '#20262b'; ctx.lineWidth = 1.5*scale;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  if(tagTxt){
    const zoomTxt = (viewAdjust && viewAdjust.zoom > 1.0001) ? `  ·  ×${viewAdjust.zoom.toFixed(1)}` : '';
    const fullTag = tagTxt + zoomTxt;
    ctx.fillStyle = 'rgba(20,26,30,.8)';
    ctx.font = `700 ${11*scale}px 'Space Grotesk', sans-serif`;
    const tagW = ctx.measureText(fullTag).width + 16*scale;
    ctx.fillRect(rect.x+8*scale, rect.y+8*scale, tagW, 22*scale);
    ctx.fillStyle = '#fff';
    ctx.fillText(fullTag, rect.x+16*scale, rect.y+23*scale);
  }
  // Vue de haut : flèche Nord dans l'image même (le plan est orienté comme
  // l'élévation choisie, donc le Nord n'est pas forcément en haut).
  if(mode==='haut') architectDrawNorthArrow(ctx, rect.x+rect.w-26*scale, rect.y+rect.h-30*scale, scale, framing);
  return framing;
}
// Petite rose du Nord (fond clair, pour les images rendues sur papier).
function architectDrawNorthArrow(ctx, cx, cy, scale, framing){
  const ang = architectNorthArrowAngle(framing);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.beginPath(); ctx.arc(0, 0, 15*scale, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#20262b'; ctx.lineWidth = 1*scale;
  ctx.beginPath(); ctx.arc(0, 0, 15*scale, 0, Math.PI*2); ctx.stroke();
  ctx.rotate(ang);
  ctx.fillStyle = '#141a1e';
  ctx.beginPath(); ctx.moveTo(0,-12*scale); ctx.lineTo(4*scale,5*scale); ctx.lineTo(0,2*scale); ctx.lineTo(-4*scale,5*scale); ctx.closePath(); ctx.fill();
  ctx.restore();
  // Le "N" suit la pointe de la flèche, à l'extérieur du cercle.
  const nx = cx + Math.sin(ang)*22*scale, ny = cy - Math.cos(ang)*22*scale;
  ctx.fillStyle = '#141a1e'; ctx.font = `700 ${10*scale}px 'Space Grotesk', sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', nx, ny);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
/* ---- Mise en état "planche" de la scène partagée, et restauration.
   Regroupé dans deux fonctions pour être réutilisé à l'identique par la
   composition complète (composeArchitectSheet) ET par le redessin partiel de
   l'image principale pendant le zoom/déplacement (redrawArchitectMainLeft) —
   sans jamais dupliquer la logique de sauvegarde/restauration.
   `rs` est rempli au fil de l'eau : si une étape lève une exception,
   endArchitectRender() ne restaure que ce qui a réellement été modifié. ---- */
function beginArchitectRender(rs){
  // Sauvegarde COMPLÈTE et symétrique de l'état de rendu du renderer WebGL
  // partagé, AVANT tout rendu de panneau — jamais de reconstruction à la
  // main à partir de `renderer.domElement.width/height` (unité physique,
  // pas logique : c'était la cause du viewport 4× trop grand après sortie
  // du Mode Architecte sur un écran Retina/HiDPI). On restaure exactement
  // cet état (quel qu'il soit) à la toute fin.
  rs.prevRenderTarget = renderer.getRenderTarget();
  rs.prevViewport = new THREE.Vector4(); renderer.getViewport(rs.prevViewport);
  rs.prevScissor = new THREE.Vector4(); renderer.getScissor(rs.prevScissor);
  rs.prevScissorTest = renderer.getScissorTest();
  rs.pedestriansWereVisible = getPedestriansVisible();
  setPedestriansVisible(false); applyAgentTypeVisibility();
  rs.vehiclesWereVisible = getVehiclesVisible();
  rs.mainBox = architectMainBox();
  rs.lightState = architectSetupLighting(rs.mainBox);
  rs.treeState = architectSetTreesTransparent();
  rs.grayscaleStash = architectApplyGrayscale();
  rs.usageColorState = architectApplyUsageColors();
  rs.prevFog = scene.fog;
  scene.fog = null; // ne pas perdre les arrière-plans dans le gris du fond (Réf. A)
  rs.fogCleared = true;
}
function endArchitectRender(rs){
  if(rs.fogCleared) scene.fog = rs.prevFog;
  if(rs.usageColorState) architectRestoreUsageColors(rs.usageColorState);
  if(rs.grayscaleStash) architectRestoreGrayscale(rs.grayscaleStash);
  if(rs.pedestriansWereVisible !== undefined){ setPedestriansVisible(rs.pedestriansWereVisible); applyAgentTypeVisibility(); }
  if(rs.lightState) architectRestoreLighting(rs.lightState);
  if(rs.treeState) architectRestoreTrees(rs.treeState);
  // Restauration SYMÉTRIQUE de l'état de rendu sauvegardé au début — jamais
  // de reconstruction à la main à partir de `renderer.domElement.width/height`
  // (unité physique, pas logique : c'était le vrai bug à l'origine du viewport
  // 4× trop grand sur écran Retina/HiDPI). On revient exactement à l'état
  // d'avant, quel qu'il ait été (y compris si un scissor test était actif, ou
  // un autre render target que le canvas principal).
  if(rs.prevViewport){
    renderer.setRenderTarget(rs.prevRenderTarget);
    renderer.setViewport(rs.prevViewport);
    renderer.setScissor(rs.prevScissor);
    renderer.setScissorTest(rs.prevScissorTest);
  }
}
function composeArchitectSheet(ctx, W, H, scale){
  scale = scale || 1;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = ARCHITECT_PAPER;
  ctx.fillRect(0,0,W,H);

  const sortedNew = architectSortedNewBuildings();
  // ATTENTION : `extensionGareMesh` ("Extension_Gare" du GLB) n'est qu'un
  // GABARIT invisible utilisé pour déformer/cloner les tranches — ce n'est
  // PAS le maillage tracé par l'utilisateur avec l'outil "Extension Gare".
  // Ce dernier est la chaîne `extHallSlices` (groupes "ExtGareTranche" déjà
  // dans la scène). Le panneau "Extension Gare" ne doit donc exister, et le
  // filaire ne doit être appliqué, que sur `extHallSlices` — jamais sur
  // `extensionGareMesh`, qui doit rester caché comme en dehors du mode Architecte.
  const hasGare = ExtGare.extHallSlices.length > 0;

  const rs = {};

  // ATTENTION (bug corrigé) : tout ce qui suit mute des états PARTAGÉS de la
  // scène (couleurs désaturées, visibilité piétons/véhicules/arbres,
  // éclairage, cible et viewport du renderer WebGL...). Sans try/finally, la
  // moindre exception levée pendant l'un des rendus (main/gare/fiches —
  // d'autant plus probable maintenant qu'il y a 4 rendus 3D au lieu de 2, et
  // des rects dont la largeur dépend d'un calcul de mise en page) laissait la
  // scène corrompue en permanence après la sortie du Mode Architecte : c'est
  // la cause des labels/hitbox de bâtiments désynchronisés du modèle 3D (ou
  // du modèle qui semble "mal placé") rapportés après coup. La restauration
  // doit donc TOUJOURS s'exécuter, qu'il y ait eu une erreur ou non.
  try{
  beginArchitectRender(rs);
  const { vehiclesWereVisible, mainBox } = rs;
  // ---- Bandeau de titre plein largeur ----
  const HEADER_H = Math.round(52*scale);
  ctx.fillStyle = '#141a1e';
  ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${16*scale}px 'Space Grotesk', sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText('PLACE DE MILAN', 14*scale, HEADER_H*0.38);
  ctx.font = `600 ${10.5*scale}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = '#9fb0bd';
  ctx.fillText('PLANCHE ARCHITECTE — NOMENCLATURE', 14*scale, HEADER_H*0.74);
  const viewLabel = architectViewMode==='axo' ? 'Axonométrie' : 'Élévation';
  const rightTxt = `${viewLabel} ${architectViewMode==='elevation'?ARCHITECT_DIR_LABELS[architectDir]:''} + Vue de haut · ${sortedNew.length} nouveau${sortedNew.length>1?'x':''} bâtiment${sortedNew.length>1?'s':''} · ${new Date().toLocaleDateString('fr-FR')}`;
  ctx.font = `600 ${11.5*scale}px 'Space Grotesk', sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillStyle = '#dfe8ef';
  ctx.fillText(rightTxt, W-14*scale, HEADER_H*0.56);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

  // ---- Mise en page ----
  const RIGHT_W = Math.round(Math.min(340, W*0.25) * scale);
  const BOTTOM_H = Math.round(Math.min(230, H*0.26) * scale);
  const PAD = Math.round(12*scale);
  // Marges verticales resserrées (haut/bas du cadre principal) : la marge
  // horizontale PAD reste identique, mais on ne réserve plus qu'une petite
  // moitié de PAD en haut et en bas de l'image principale pour qu'elle
  // occupe le plus de place possible au lieu de flotter avec de grands
  // bandeaux vides au-dessus/en dessous du polygone d'implantation.
  const mainPadV = Math.round(PAD*0.4);
  const mainRect = { x:PAD, y:HEADER_H+mainPadV, w:W-RIGHT_W-PAD*2, h:H-HEADER_H-BOTTOM_H-mainPadV-PAD };

  const PANEL_MIN_H = 150*scale;
  const rightCapacity = Math.max(1, Math.floor(mainRect.h / PANEL_MIN_H));
  const rightList = sortedNew.slice(0, Math.min(rightCapacity, sortedNew.length));
  const bottomBuildings = sortedNew.slice(rightList.length);
  const bottomList = hasGare ? [{ gare:true }, ...bottomBuildings] : bottomBuildings;
  const indexOf = new Map(sortedNew.map((b,i)=> [b, i+1]));

  // ---- Image principale : DEUX rendus 3D côte à côte — à gauche le mode
  // choisi (élévation orientable ou axonométrie), à droite systématiquement
  // la vue de haut correspondante. Il y a assez de place à l'écran pour
  // les montrer toutes les deux en permanence, plus besoin d'un bouton
  // dédié pour basculer sur la vue de haut. Largeurs bornées à un minimum
  // pour rester valides même sur une fenêtre étroite (jamais 0/négatif —
  // `ctx.drawImage` avec une largeur ≤ 0 lève une exception). ----
  const mainGap = Math.round(PAD*0.7);
  const mainLeftW = Math.max(40*scale, Math.min(mainRect.w-40*scale, Math.round(mainRect.w*0.58)));
  const mainRectLeft = { x:mainRect.x, y:mainRect.y, w:mainLeftW, h:mainRect.h };
  const mainRectRight = { x:mainRect.x+mainLeftW+mainGap, y:mainRect.y, w:Math.max(40*scale, mainRect.w-mainLeftW-mainGap), h:mainRect.h };
  // Seule la composition à l'échelle écran (scale 1) alimente `architectLayout` :
  // l'export PNG (échelle > 1) n'a pas à écraser la géométrie de l'écran.
  if(scale === 1) architectLayout = { mainRectLeft: { ...mainRectLeft }, sortedNew, indexOf };
  const mainFramingLeft = drawArchitectMainView(ctx, mainRectLeft, mainBox, architectDir, architectViewMode, scale, sortedNew, indexOf, vehiclesWereVisible, ARCHITECT_MAIN_TAG, architectViewAdjust);
  drawArchitectMainView(ctx, mainRectRight, mainBox, architectDir, 'haut', scale, sortedNew, indexOf, vehiclesWereVisible, 'VUE DE HAUT');
  const mainFraming = mainFramingLeft; // référence pour l'échelle/la flèche Nord du cartouche

  // ---- Fiches bâtiments (100% calculées — coupe + nomenclature) ----
  if(rightList.length){
    const colX = mainRect.x + mainRect.w + PAD;
    const colW = RIGHT_W - PAD;
    const cellH = mainRect.h / rightList.length;
    rightList.forEach((b, i)=>{
      const rect = { x:colX, y:mainRect.y + i*cellH, w:colW, h:cellH - (i<rightList.length-1?PAD*0.7:0) };
      drawArchitectBuildingCard(ctx, rect, b, scale, indexOf.get(b));
    });
  }
  if(bottomList.length){
    const rowY = mainRect.y + mainRect.h + PAD;
    const rowW = mainRect.w;
    const cellW = rowW / bottomList.length;
    bottomList.forEach((item, i)=>{
      const rect = { x:mainRect.x + i*cellW, y:rowY, w:cellW - (i<bottomList.length-1?PAD*0.7:0), h:BOTTOM_H - PAD };
      if(item.gare) drawArchitectGarePanel(ctx, rect, scale);
      else drawArchitectBuildingCard(ctx, rect, item, scale, indexOf.get(item));
    });
  }

  // ---- Cartouche / légende (coin bas-droit) ----
  const titleRect = { x:mainRect.x+mainRect.w+PAD, y:mainRect.y+mainRect.h+PAD, w:RIGHT_W-PAD, h:BOTTOM_H-PAD };
  drawArchitectTitleBlock(ctx, titleRect, scale, { count:sortedNew.length }, mainFraming);
  } finally {
    // ---- Restauration (garantie, même en cas d'erreur ci-dessus) ----
    endArchitectRender(rs);
  }
}
const ARCHITECT_MAIN_TAG = 'ENSEMBLE — POLYGONE D\'IMPLANTATION';
// Redessin PARTIEL : uniquement l'image principale de gauche (zoom/déplacement
// à la loupe/main) — sans recomposer fiches, cartouche ni vue de haut. Réutilise
// exactement la même mise en état de la scène que la composition complète.
function redrawArchitectMainLeft(){
  if(!architectModeActive || !architectLayout) return;
  const rect = architectLayout.mainRectLeft;
  const rs = {};
  try{
    beginArchitectRender(rs);
    architectCtx.save();
    architectCtx.beginPath(); architectCtx.rect(rect.x-1, rect.y-1, rect.w+2, rect.h+2); architectCtx.clip();
    architectCtx.fillStyle = ARCHITECT_PAPER;
    architectCtx.fillRect(rect.x-1, rect.y-1, rect.w+2, rect.h+2);
    drawArchitectMainView(architectCtx, rect, rs.mainBox, architectDir, architectViewMode, 1,
      architectLayout.sortedNew, architectLayout.indexOf, rs.vehiclesWereVisible, ARCHITECT_MAIN_TAG, architectViewAdjust);
    architectCtx.restore();
  } finally {
    endArchitectRender(rs);
  }
}

function architectPanelShadow(ctx, rect, scale){
  ctx.save();
  ctx.shadowColor = 'rgba(20,26,30,.28)';
  ctx.shadowBlur = 10*scale; ctx.shadowOffsetY = 3*scale;
  ctx.fillStyle = '#fff';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}
// Fiche d'un nouveau bâtiment — ENTIÈREMENT calculée (pas de rendu 3D) :
// à gauche une "coupe" en bandes horizontales empilées (Réf. B : alternance
// claire/foncée un étage sur deux, trait de plancher, cotation de hauteur),
// à droite sa nomenclature.
function drawArchitectBuildingCard(ctx, rect, b, scale, index){
  architectPanelShadow(ctx, rect, scale);
  ctx.strokeStyle = '#c9c4b8'; ctx.lineWidth = 1*scale;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  const sheet = architectBuildingSheet(b);
  const coupe = architectBuildingCoupeData(b, architectDir);

  // en-tête (numéro, nom, pictogramme d'emprise réelle en haut à droite)
  const padX = 10*scale, padTop = 10*scale;
  const r = 10*scale;
  ctx.beginPath(); ctx.arc(rect.x+padX+r, rect.y+padTop+r, r, 0, Math.PI*2);
  ctx.fillStyle = '#141a1e'; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `700 ${10.5*scale}px 'Space Grotesk', sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(index), rect.x+padX+r, rect.y+padTop+r+0.5*scale);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#141a1e';
  ctx.font = `700 ${12.5*scale}px 'Space Grotesk', sans-serif`;
  const nameMaxW = (rect.x+rect.w-padX-30*scale-6*scale) - (rect.x+padX+r*2+8*scale);
  let nameTxt = sheet.name;
  while(ctx.measureText(nameTxt).width > nameMaxW && nameTxt.length>3){ nameTxt = nameTxt.slice(0,-2)+'…'; }
  ctx.fillText(nameTxt, rect.x+padX+r*2+8*scale, rect.y+padTop+r+4*scale);
  const iconSize = 30*scale;
  architectDrawFootprintIcon(ctx, rect.x+rect.w-padX-iconSize/2, rect.y+padTop+iconSize/2, iconSize, b.points, scale);

  const bodyY = rect.y + padTop + r*2 + 14*scale;
  const bodyH = rect.h - (bodyY-rect.y) - 22*scale; // réserve la place du sol matérialisé + cote totale
  const dimW = 16*scale; // colonne de cotation de hauteur à gauche
  const coupeW = Math.max(46*scale, rect.w*0.24);
  const coupeX = rect.x + padX + dimW;
  const textX = coupeX + coupeW + 22*scale; // marge à droite pour les étiquettes R+XX
  const textW = rect.x + rect.w - 10*scale - textX;

  // Réserve verticale du bloc de nomenclature résumée (étages/emprise/m²
  // développés + légende des usages), dessiné plus bas dans cette même
  // colonne `textX`. Les étiquettes d'étage (R+XX · Usage) ci-dessous
  // partagent CETTE colonne : sans cette réserve, elles se superposaient
  // au texte de la nomenclature dès que le bâtiment avait plusieurs étages
  // proches du haut de la coupe (le bug de chevauchement rapporté).
  let nomenBottom = bodyY + 11*scale + 15*scale + 13*scale + 15*scale;
  if(textW >= 30*scale){
    sheet.usageLines.forEach(()=>{ if(nomenBottom <= rect.y+rect.h-4*scale) nomenBottom += 12.5*scale; });
  }
  const floorLabelMinY = nomenBottom + 6*scale;

  // -- coupe (silhouette réelle, bandes empilées, alternance clair/foncé) --
  const baseY = bodyY + bodyH;
  const pxPerM = bodyH / Math.max(1, coupe.totalH);
  const barMaxW = coupeW * 0.82;
  const pxPerMw = barMaxW / Math.max(1, coupe.maxSpan);
  const barCx = coupeX + coupeW/2;
  const labelStep = Math.max(1, Math.ceil(9*scale / Math.max(1,pxPerM))); // évite le fouillis si trop d'étages
  coupe.floors.forEach(fl=>{
    const fh = Math.max(1, fl.h*pxPerM);
    const fy = baseY - (fl.y+fl.h)*pxPerM;
    const fx = barCx + fl.left*pxPerMw;
    const fw = Math.max(4*scale, (fl.right-fl.left)*pxPerMw);
    const baseHex = USAGE_COLORS[fl.usage]!==undefined ? USAGE_COLORS[fl.usage] : 0x999999;
    const shaded = architectShadeColor(baseHex, fl.f%2===0 ? 0.8 : 1.0);
    ctx.fillStyle = `#${shaded.toString(16).padStart(6,'0')}`;
    ctx.fillRect(fx, fy, fw, fh);
    // trait de plancher : traverse toute la largeur de la coupe
    ctx.strokeStyle = 'rgba(20,26,30,.55)'; ctx.lineWidth = 0.5*scale;
    ctx.beginPath(); ctx.moveTo(barCx-barMaxW/2, fy); ctx.lineTo(barCx+barMaxW/2, fy); ctx.stroke();
    // étiquette R+XX · Usage, une ligne sur `labelStep` pour rester lisible —
    // jamais dans la zone réservée à la nomenclature résumée (voir plus haut).
    if(fl.f % labelStep === 0 && fw > 2*scale && (fy+fh/2) >= floorLabelMinY){
      ctx.fillStyle = '#20262b';
      ctx.font = `500 ${8.5*scale}px 'IBM Plex Mono', monospace`;
      ctx.textBaseline = 'middle';
      ctx.fillText(`R+${String(fl.f).padStart(2,'0')}`, textX, fy+fh/2);
      ctx.font = `400 ${7.5*scale}px 'Inter', sans-serif`;
      ctx.fillStyle = '#6b7680';
      const rTxt = ctx.measureText(`R+${String(fl.f).padStart(2,'0')} `).width;
      const uTxt = USAGE_LABELS[fl.usage] || fl.usage;
      if(textW > rTxt + 20*scale) ctx.fillText(uTxt, textX+rTxt, fy+fh/2);
      ctx.textBaseline = 'alphabetic';
    }
  });
  // trait de coupe : contour, plus épais que les traits de plancher
  ctx.strokeStyle = '#20262b'; ctx.lineWidth = 1.5*scale;
  ctx.strokeRect(barCx-barMaxW/2, bodyY, barMaxW, bodyH);
  // sol matérialisé : bande hachurée (convention architecturale)
  const groundBandH = 5*scale;
  ctx.save();
  ctx.beginPath(); ctx.rect(barCx-barMaxW/2, baseY, barMaxW, groundBandH); ctx.clip();
  ctx.fillStyle = '#d8d3c6'; ctx.fillRect(barCx-barMaxW/2, baseY, barMaxW, groundBandH);
  ctx.strokeStyle = 'rgba(32,38,43,.5)'; ctx.lineWidth = 0.6*scale;
  for(let hx=-barMaxW; hx<barMaxW*2; hx+=5*scale){
    ctx.beginPath(); ctx.moveTo(barCx-barMaxW/2+hx, baseY+groundBandH); ctx.lineTo(barCx-barMaxW/2+hx+groundBandH, baseY); ctx.stroke();
  }
  ctx.restore();
  // cotation de hauteur totale sur le côté gauche : ligne + tirets + cote
  ctx.strokeStyle = '#4a5560'; ctx.lineWidth = 0.8*scale;
  ctx.beginPath(); ctx.moveTo(coupeX-dimW*0.4, bodyY); ctx.lineTo(coupeX-dimW*0.4, baseY); ctx.stroke();
  [0, b.bands.length>1?coupe.totalH/2:null, coupe.totalH].forEach(v=>{
    if(v===null) return;
    const ty = baseY - v*pxPerM;
    ctx.beginPath(); ctx.moveTo(coupeX-dimW*0.6, ty); ctx.lineTo(coupeX-dimW*0.2, ty); ctx.stroke();
  });
  ctx.fillStyle = '#4a5560'; ctx.font = `600 ${8*scale}px 'IBM Plex Mono', monospace`;
  ctx.save(); ctx.translate(coupeX-dimW*0.75, bodyY+8*scale); ctx.rotate(-Math.PI/2);
  ctx.textAlign='left'; ctx.fillText(sheet.height, 0, 0);
  ctx.restore();
  ctx.textAlign = 'center'; ctx.fillStyle = '#4a5560'; ctx.font = `600 ${9*scale}px 'Space Grotesk', sans-serif`;
  ctx.fillText(sheet.height, barCx, baseY + groundBandH + 12*scale);
  ctx.textAlign = 'left';

  // -- nomenclature --
  let ty = bodyY + 11*scale;
  ctx.fillStyle = '#141a1e';
  ctx.font = `700 ${11*scale}px 'Space Grotesk', sans-serif`;
  ctx.fillText(sheet.floors, textX, ty); ty += 15*scale;
  ctx.font = `600 ${9.5*scale}px 'Space Grotesk', sans-serif`;
  ctx.fillStyle = '#4a5560';
  ctx.fillText(sheet.footprint, textX, ty); ty += 13*scale;
  ctx.fillText(sheet.developed, textX, ty); ty += 15*scale;
  sheet.usageLines.forEach(u=>{
    if(ty > rect.y+rect.h-4*scale || textW < 30*scale) return;
    ctx.fillStyle = `#${u.color.toString(16).padStart(6,'0')}`;
    ctx.beginPath(); ctx.arc(textX+3.5*scale, ty-3.5*scale, 3.5*scale, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#6b7680';
    ctx.fillText(u.text, textX+11*scale, ty); ty += 12.5*scale;
  });
}
// Fiche extension gare — vue FILAIRE de l'extension, dans son contexte
// (le reste de la maquette reste visible normalement, rien n'est masqué) :
// seuls les matériaux de l'extension basculent temporairement en fil de
// fer (couleur vive) pour qu'elle ressorte nettement au milieu du site réel.
// Deux images côte à côte, comme l'image principale : mode choisi à gauche,
// vue de haut systématique à droite.
//
// ATTENTION (bug corrigé) : le maillage à rendre filaire est la chaîne de
// tranches RÉELLEMENT TRACÉE par l'utilisateur avec l'outil "Extension
// Gare" (`extHallSlices`, groupes nommés "ExtGareTranche", déjà présents
// dans `scene`) — PAS `extensionGareMesh`. Ce dernier ("Extension_Gare" du
// GLB) n'est qu'un gabarit invisible servant à déformer/cloner ces
// tranches ; il n'a jamais vocation à être affiché ni rendu filaire, et le
// faire basculait le mauvais volume (celui du hall) en fil de fer.
// On limite aussi explicitement le `traverse` aux groupes des tranches
// pour ne jamais rendre filaire un autre maillage du site par effet de bord.
function drawArchitectGarePanel(ctx, rect, scale){
  if(!ExtGare.extHallSlices.length) return;
  architectPanelShadow(ctx, rect, scale);
  const legendH = 32*scale;
  const imgH = rect.h - legendH;

  const box = new THREE.Box3();
  ExtGare.extHallSlices.forEach(s=> box.union(new THREE.Box3().setFromObject(s.group)));
  box.expandByScalar(80); // marge de contexte : on voit ce qui l'entoure

  // Seule la maquette du site réel (siteRoot / place_de_milan.glb) doit
  // être visible ici — la maquette élargie (global.glb) est normalement
  // masquée en dehors de la Vue Globale, mais on le garantit explicitement
  // pour cette fiche : elle cachait l'extension.
  const globalRootWasVisible = globalRoot.visible;
  globalRoot.visible = false;

  // ATTENTION (bug corrigé) : les tranches réutilisent DIRECTEMENT les
  // matériaux du site (voir extDeformModuleToQuad : glass, BATIMENTS_fenetre…
  // partagés par référence, indispensables à leur shader de fenêtres de
  // nuit). Passer `wireframe=true` sur ces matériaux rendait donc filaire
  // TOUT objet de la maquette qui les utilise aussi (hall, façades
  // existantes), pas seulement l'extension dessinée. On ne touche plus
  // jamais à un matériau : on remplace TEMPORAIREMENT le matériau des seuls
  // maillages de l'extension par un matériau filaire dédié, puis on remet
  // exactement les matériaux d'origine.
  const wireMat = new THREE.MeshBasicMaterial({ color:0x2ee8ff, wireframe:true, fog:false, side:THREE.DoubleSide });
  const swappedMeshes = []; // [mesh, matériau d'origine]
  ExtGare.extHallSlices.forEach(s=> s.group.traverse(o=>{
    if(!o.isMesh) return; // exclut les LineSegments/Line (contour, halo) : jamais touchés
    swappedMeshes.push([o, o.material]);
    o.material = wireMat;
  }));

  const gap = Math.round(rect.w*0.015);
  const leftW = Math.max(30*scale, Math.min(rect.w-gap-30*scale, Math.round((rect.w-gap)*0.56)));
  const rectLeft = { x:rect.x, y:rect.y, w:leftW, h:imgH };
  const rectRight = { x:rect.x+leftW+gap, y:rect.y, w:Math.max(30*scale, rect.w-leftW-gap), h:imgH };
  const modeLeft = architectViewMode; // 'elevation' | 'axo' — jamais 'haut', toujours affichée à droite en plus

  // Restauration garantie (filaire + visibilité globalRoot) même si l'un des
  // deux rendus lève une exception — sinon l'extension restait bloquée en
  // filaire cyan et/ou la maquette élargie restait masquée après la sortie
  // du Mode Architecte.
  try{
    [[rectLeft, modeLeft, 'Extension Gare'], [rectRight, 'haut', null]].forEach(([r, mode, onImgTxt])=>{
      const res = renderArchitectPanelCanvas(box, architectDir, mode, r.w, r.h, 1.15);
      ctx.drawImage(res.cnv, r.x, r.y, r.w, r.h);
      if(mode==='elevation') architectDrawGroundMask(ctx, r, r.h, res.groundY);
      ctx.strokeStyle = '#20262b'; ctx.lineWidth = 2*scale;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // Titre directement sur l'image de gauche uniquement (en plus de la
      // légende commune sous les deux images), sur fond noir semi-transparent.
      if(onImgTxt){
        ctx.font = `700 ${11*scale}px 'Space Grotesk', sans-serif`;
        const onImgW = ctx.measureText(onImgTxt).width + 16*scale;
        ctx.fillStyle = 'rgba(20,26,30,.78)';
        ctx.fillRect(r.x+8*scale, r.y+8*scale, onImgW, 20*scale);
        ctx.fillStyle = '#fff';
        ctx.fillText(onImgTxt, r.x+16*scale, r.y+22*scale);
      }
    });
  } finally {
    swappedMeshes.forEach(([o, m])=>{ o.material = m; });
    wireMat.dispose();
    globalRoot.visible = globalRootWasVisible;
  }

  ctx.fillStyle = '#fff';
  ctx.fillRect(rect.x, rect.y+imgH, rect.w, legendH);
  ctx.strokeStyle = '#c9c4b8';
  ctx.strokeRect(rect.x, rect.y+imgH, rect.w, legendH);
  ctx.fillStyle = '#141a1e';
  ctx.font = `700 ${12*scale}px 'Space Grotesk', sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText('Extension Gare (fil de fer, en contexte)', rect.x+8*scale, rect.y+imgH+7*scale);
  ctx.font = `600 ${9.5*scale}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = '#4a5560';
  const modeLabel = (modeLeft==='axo' ? 'Axonométrie' : `Élévation ${ARCHITECT_DIR_LABELS[architectDir]}`) + ' + Vue de haut';
  ctx.fillText(modeLabel, rect.x+8*scale, rect.y+imgH+20*scale);
  ctx.textBaseline = 'alphabetic';
}
function drawArchitectTitleBlock(ctx, rect, scale, info, mainFraming){
  architectPanelShadow(ctx, rect, scale);
  ctx.fillStyle = '#141a1e';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  let ty = rect.y + 20*scale;
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${13*scale}px 'Space Grotesk', sans-serif`;
  ctx.fillText('LÉGENDE DES USAGES', rect.x+10*scale, ty); ty += 20*scale;
  ctx.font = `600 ${10*scale}px 'Space Grotesk', sans-serif`;
  Object.keys(USAGE_LABELS).forEach(usage=>{
    if(ty > rect.y+rect.h-56*scale) return;
    ctx.fillStyle = `#${(USAGE_COLORS[usage]||0x999999).toString(16).padStart(6,'0')}`;
    ctx.beginPath(); ctx.arc(rect.x+13*scale, ty-3.5*scale, 4*scale, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#cfd8de';
    ctx.fillText(USAGE_LABELS[usage], rect.x+23*scale, ty);
    ty += 15*scale;
  });

  // ---- Échelle graphique (0-10-20-50 m) + flèche Nord, en bas du cartouche ----
  const barY = rect.y + rect.h - 40*scale;
  // Approximation valable en projection orthographique : l'axe X écran
  // correspond directement aux unités monde de `halfW` de l'image
  // principale — le cartouche occupant environ RIGHT_W de la largeur
  // totale, l'image principale fait grossièrement ~3.2x la largeur de
  // cette colonne.
  const metersPerPixel = mainFraming ? (mainFraming.halfW*2) / (rect.w*3.2) : 1;
  const scaleTicks = [0,10,20,50];
  const scaleX0 = rect.x + 14*scale;
  ctx.strokeStyle = '#cfd8de'; ctx.fillStyle = '#cfd8de'; ctx.lineWidth = 1*scale;
  ctx.beginPath(); ctx.moveTo(scaleX0, barY);
  scaleTicks.forEach(m=>{
    const px = scaleX0 + (m/metersPerPixel);
    ctx.moveTo(px, barY-4*scale); ctx.lineTo(px, barY+4*scale);
  });
  ctx.moveTo(scaleX0, barY); ctx.lineTo(scaleX0 + (scaleTicks[scaleTicks.length-1]/metersPerPixel), barY);
  ctx.stroke();
  ctx.font = `500 ${7.5*scale}px 'IBM Plex Mono', monospace`;
  ctx.textAlign = 'center';
  scaleTicks.forEach(m=>{
    const px = scaleX0 + (m/metersPerPixel);
    ctx.fillText(String(m), px, barY+14*scale);
  });
  ctx.textAlign = 'left';

  // Flèche Nord : petite rose des vents simplifiée, orientée selon le
  // cadrage figé de l'image principale.
  const nAngle = mainFraming ? architectNorthArrowAngle(mainFraming) : 0;
  const nCx = rect.x + rect.w - 26*scale, nCy = barY;
  ctx.save();
  ctx.translate(nCx, nCy); ctx.rotate(nAngle);
  ctx.strokeStyle = '#cfd8de'; ctx.lineWidth = 1*scale;
  ctx.beginPath(); ctx.arc(0,0,12*scale,0,Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,-10*scale); ctx.lineTo(3.5*scale,4*scale); ctx.lineTo(0,1*scale); ctx.lineTo(-3.5*scale,4*scale); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#cfd8de'; ctx.font = `700 ${8*scale}px 'Space Grotesk', sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('N', nCx, nCy-16*scale);
  ctx.textAlign = 'left';

  // Mention légale
  ctx.fillStyle = '#7f93a3'; ctx.font = `400 ${8*scale}px 'IBM Plex Mono', monospace`;
  ctx.fillText('Échelle indicative — non contractuelle', rect.x+10*scale, rect.y+rect.h-6*scale);
}

function renderArchitectComposition(){
  if(!architectModeActive) return;
  const W = window.innerWidth, H = window.innerHeight;
  if(architectCanvas.width!==W || architectCanvas.height!==H){
    architectCanvas.width = W; architectCanvas.height = H;
  }
  composeArchitectSheet(architectCtx, W, H, 1);
}
function exportArchitectComposition(){
  if(!architectModeActive) return;
  const EXPORT_SCALE = 1.8;
  const W = Math.round(window.innerWidth*EXPORT_SCALE), H = Math.round(window.innerHeight*EXPORT_SCALE);
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const offCtx = off.getContext('2d');
  composeArchitectSheet(offCtx, W, H, EXPORT_SCALE);
  const link = document.createElement('a');
  link.download = `place-de-milan_planche-architecte_${Date.now()}.png`;
  link.href = off.toDataURL('image/png');
  link.click();
  renderArchitectComposition();
}

