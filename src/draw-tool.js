// OUTIL DE TRACÉ — polygone/rectangle pour poser un nouveau bâtiment au sol,
// ou un "volume supérieur" (décroché) sur le toit d'un bâtiment existant.
// Extrait d'index.html.
//
// Contrairement aux outils arbres/gazon/labels (self-contained), ce module
// est le coeur de la machine à état qui PILOTE la création/modification de
// bâtiments — mais ne les crée/modifie pas lui-même : tout ce qui se passe
// une fois un tracé terminé (createBuilding, addVolumeToBuilding, rendu des
// panneaux, etc.) reste injecté depuis index.html via initDrawTool(), sur le
// même principe que camera-architect.js. draw-tool.js possède la mécanique
// de tracé/accrochage/glisser-rectangle, les deux modales "nombre d'étages",
// et la grille de repère du toit pour un volume supérieur.

import * as THREE from "three";
import {
  controls, renderer, worldRoot, buildZone, buildings, editingBuildingId,
  treePlacing, amenagementPlacing, grassPainting, labelPlacing,
} from './state.js';
import * as AppState from './state.js';
import {
  closestPointOnSegment, clampPointToPolygon, snapPointToZone, snapToFootprintEdges,
  repairEdgeAgainstZone, cleanPolygonPoints, simplifyClosedPolygon, polygonAreaXZ,
  polygonOutsideAreaRatio, shrinkPolygonToFitOverlap, VERTEX_SNAP_RADIUS, EDGE_SNAP_RADIUS,
} from './geometry-utils.js';
import { footprintForBand, buildingTotalHeight } from './building-utils.js';
import { NEON_BLUE, NEON_BLUE_CSS, DEFAULT_USAGE } from './config.js';
import * as ExtGare from './extension-gare.js';
import * as Trees from './trees.js';
import * as Amenagements from './amenagements.js';
import * as Grass from './grass.js';
import * as Labels from './labels.js';

// Dépendances pas encore extraites (édition de bâtiment, mode construction,
// panneaux, déplacement/clonage...), injectées une fois par initDrawTool() —
// voir le commentaire équivalent dans camera-architect.js.
let stopEditBuildingShape, enterConstructionMode, exitConstructionMode,
    lockPlanViewForZoneDraw, unlockPlanViewAfterVolumeDraw, lockPlanViewForVolumeDraw,
    showZoneHazardOutline, hideDrawGuide, groundPointFromEvent,
    renderList, getBewSelectedForBuildingId, renderBldgEditWindow,
    createBuilding, startBuildingConstruction, normalizeBands, rebuildMesh,
    openBldgEditWindow, applyConstructionGrayscale, getMovingBuildingId,
    buildingExceedsZone, stopMoveBuilding, cancelMoveBuilding,
    makeHazardStripeOutline, getMaxBuildingFloors, getDefaultMotif, getDefaultFacadeTint,
    registerScreenSizedMarker, unregisterScreenSizedMarkersOf, setSelectedId;

export function initDrawTool(deps){
  ({
    stopEditBuildingShape, enterConstructionMode, exitConstructionMode,
    lockPlanViewForZoneDraw, unlockPlanViewAfterVolumeDraw, lockPlanViewForVolumeDraw,
    showZoneHazardOutline, hideDrawGuide, groundPointFromEvent,
    renderList, getBewSelectedForBuildingId, renderBldgEditWindow,
    createBuilding, startBuildingConstruction, normalizeBands, rebuildMesh,
    openBldgEditWindow, applyConstructionGrayscale, getMovingBuildingId,
    buildingExceedsZone, stopMoveBuilding, cancelMoveBuilding,
    makeHazardStripeOutline, getMaxBuildingFloors, getDefaultMotif, getDefaultFacadeTint,
    registerScreenSizedMarker, unregisterScreenSizedMarkersOf, setSelectedId,
  } = deps);
  // Câblage différé jusqu'ici plutôt qu'au chargement du module : worldRoot et
  // renderer (depuis state.js) sont encore null au moment où ce module ES est
  // évalué (les imports statiques s'exécutent avant le corps du script
  // d'index.html, qui les crée) — voir le commentaire équivalent dans trees.js.
  worldRoot.add(drawMarkers);
  wireDrawClickHandler();
  wireDrawPointerDownHandler();
  wireDrawPointerMoveHandler();
}

/* ============================================================
   STATE — machine à état du tracé, possédée par ce module.
   ============================================================ */
let drawing = false;
AppState.setDrawing(drawing);
export let drawMode = 'polygon'; // 'polygon' | 'rect'
export let drawPoints = [];
export let rectDragging = false;
export let rectStartPt = null;
export let drawMarkers = new THREE.Group(); // ajouté à worldRoot dans initDrawTool() (voir commentaire là-bas)
export let previewLine = null;
// Tracé d'un "volume supérieur" (décroché posé sur le toit d'un bâtiment
// existant) : réutilise exactement la même machine à état que le tracé d'un
// nouveau bâtiment (drawing/drawPoints/drawMode/finishDraw…), simplement
// signalée par cet id non-nul — voir startVolumeDraw().
export let volumeDrawTargetId = null;
export let volumeDrawRoofY = 0;

/* ============================================================
   DRAW MODE
   ============================================================ */
const btnDraw = document.getElementById('btn-draw');
const drawModePopout = document.getElementById('draw-mode-popout');
const btnModeRect = document.getElementById('btn-mode-rect');
const btnModePoly = document.getElementById('btn-mode-poly');
const drawHint = document.getElementById('draw-hint');
const drawHintText = document.getElementById('draw-hint-text');
const drawHintEnter = document.getElementById('draw-hint-enter');
const drawAreaLabel = document.getElementById('draw-area-label');
let currentDrawLiveArea = null, currentDrawLiveCentroid = null;
export function updateDrawAreaLabel(){
  if(!drawing || currentDrawLiveArea===null || !currentDrawLiveCentroid){
    drawAreaLabel.classList.remove('show');
    return;
  }
  // Affichage fixe en haut au centre de l'écran (voir CSS #draw-area-label) —
  // ne suit plus le tracé en 3D : plus simple à lire, et jamais caché par un
  // bâtiment ou un angle de caméra défavorable.
  drawAreaLabel.textContent = `${currentDrawLiveArea.toFixed(0)} m² au sol`;
  drawAreaLabel.classList.add('show');
}
// NOTE : #bldg-mini-list a été remplacé par la liste permanente du panneau
// #bldg-panel (déplacé sous le menu outils) — cette variable ne correspond
// plus à aucun élément du DOM. On garde uniquement le rafraîchissement de la
// liste (renderList), sans toucher à une classe "show" sur un élément qui
// n'existe plus (l'ancien code plantait ici avec une TypeError sur
// `null.classList`, ce qui empêchait tout le reste de la fonction appelante
// de s'exécuter — d'où l'impossibilité de dessiner un bâtiment).
let drawMenuOpen = false;
AppState.setDrawMenuOpen(drawMenuOpen);

function refreshBldgMiniListVisibility(){
  const show = drawMenuOpen || drawing;
  if(show) renderList();
}
function openDrawMenu(){
  drawMenuOpen = true;
  AppState.setDrawMenuOpen(drawMenuOpen);
  btnDraw.classList.add('active');
  const r = btnDraw.getBoundingClientRect();
  drawModePopout.style.left = (r.right + 8) + 'px';
  drawModePopout.style.top = r.top + 'px';
  drawModePopout.classList.add('show');
  refreshBldgMiniListVisibility();
}
export function closeDrawMenu(){
  drawMenuOpen = false;
  AppState.setDrawMenuOpen(drawMenuOpen);
  drawModePopout.classList.remove('show');
  if(!drawing) btnDraw.classList.remove('active');
  refreshBldgMiniListVisibility();
}

function startDraw(mode){
  if(treePlacing) Trees.stopTreeTool();
  if(amenagementPlacing) Amenagements.stopAmenagementsTool();
  if(grassPainting) Grass.stopGrassTool();
  if(labelPlacing) Labels.stopLabelTool();
  ExtGare.cancelExtensionGareIfActive();
  if(editingBuildingId) stopEditBuildingShape();
  drawMode = mode || 'polygon';
  drawing = true; drawPoints = [];
  AppState.setDrawing(drawing);
  clearMarkers();
  btnDraw.classList.add('active');
  btnDraw.querySelector('.tool-btn-label').textContent = drawMode==='rect' ? 'Dessin en cours (rectangle)…' : 'Dessin en cours…';
  drawHintText.textContent = drawMode==='rect'
    ? 'Cliquez-glissez sur le sol pour tracer le rectangle du bâtiment, Échap annuler, Entrée valider'
    : 'Cliquez sur le sol pour poser les sommets du bâtiment';
  drawHintEnter.style.display = drawMode==='rect' ? 'none' : '';
  drawHint.classList.add('show');
  enterConstructionMode();
  lockPlanViewForZoneDraw();
  showZoneHazardOutline();
  refreshBldgMiniListVisibility();
}
export function cancelDraw(){
  const cancelledVolumeTargetId = volumeDrawTargetId; // mémorisé AVANT réinitialisation, pour rafraîchir la fiche bâtiment si besoin (voir plus bas)
  drawing = false; drawPoints = []; rectDragging = false; rectStartPt = null;
  AppState.setDrawing(drawing);
  currentDrawLiveArea = null; currentDrawLiveCentroid = null;
  drawAreaLabel.classList.remove('show');
  clearMarkers();
  Trees.clearTreesOverlapWarning();
  btnDraw.classList.remove('active');
  btnDraw.querySelector('.tool-btn-label').textContent = 'Nouveau bâtiment';
  drawHint.classList.remove('show');
  drawHintEnter.style.display = '';
  controls.enabled = true;
  closeDrawMenu();
  volumeDrawTargetId = null;
  hideVolumeRoofGrid();
  unlockPlanViewAfterVolumeDraw();
  exitConstructionMode();
  refreshBldgMiniListVisibility();
  // Sécurité : si un tracé de volume supérieur est annulé (ou vient d'aboutir,
  // finishDraw() appelant cancelDraw() avant d'ouvrir la modale d'étages)
  // alors que la fiche du MÊME bâtiment est ouverte à droite, on la
  // rafraîchit pour qu'elle cesse d'afficher "✕ Annuler le tracé" — sinon un
  // clic dessus relance startVolumeDraw() au lieu de ne rien faire, puisque
  // volumeDrawTargetId est déjà retombé à null (voir bewSelectedForBuildingId,
  // renderBldgEditWindow ci-dessous).
  if(cancelledVolumeTargetId!==null && getBewSelectedForBuildingId()===cancelledVolumeTargetId){
    const b = buildings.find(x=>x.id===cancelledVolumeTargetId);
    if(b) renderBldgEditWindow(b);
  }
}
function clearMarkers(){
  unregisterScreenSizedMarkersOf(drawMarkers);
  drawMarkers.clear();
  if(previewLine){ worldRoot.remove(previewLine); previewLine.geometry.dispose(); previewLine=null; }
  if(previewHazard){ worldRoot.remove(previewHazard); previewHazard=null; }
  hideDrawGuide();
}
let previewHazard = null;
function refreshPreview(){
  if(previewLine){ worldRoot.remove(previewLine); previewLine.geometry.dispose(); previewLine=null; }
  if(previewHazard){ worldRoot.remove(previewHazard); previewHazard=null; }
  if(drawPoints.length<2) return;
  const pts = drawPoints.map(p=>new THREE.Vector3(p.x,0.15,p.z));
  pts.push(pts[0].clone());
  previewLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color:NEON_BLUE })
  );
  worldRoot.add(previewLine);
  // Bande zébrée noir/jaune type chantier le long du contour en cours de
  // tracé — visible même grille désactivée, pour bien signaler "en travaux".
  previewHazard = makeHazardStripeOutline(drawPoints, 0.5);
  worldRoot.add(previewHazard);
  // Surface au sol en direct pendant le tracé — dès que le contour a de quoi
  // former un polygone (3 sommets minimum).
  if(drawPoints.length>=3){
    currentDrawLiveArea = polygonAreaXZ(drawPoints);
    currentDrawLiveCentroid = drawPoints.reduce((s,p)=>({x:s.x+p.x, z:s.z+p.z}), {x:0,z:0});
    currentDrawLiveCentroid.x /= drawPoints.length; currentDrawLiveCentroid.z /= drawPoints.length;
  } else {
    currentDrawLiveArea = null; currentDrawLiveCentroid = null;
  }
}
// Aimantation sur les sommets/arêtes des AUTRES bâtiments déjà posés — utilisé
// UNIQUEMENT pendant le tracé d'un NOUVEAU bâtiment au sol (pas pour un volume
// supérieur, qui s'aimante déjà sur le bâtiment support via snapToFootprintEdges).
// Même logique priorité sommet > bord que snapPointToZone, mais balayée sur
// tous les bâtiments existants à la fois (le plus proche gagne).
function snapPointToOtherBuildings(pt, excludeId){
  let bestVertex = null, bestVertexDist = VERTEX_SNAP_RADIUS;
  let bestEdge = null, bestEdgeDist = EDGE_SNAP_RADIUS;
  buildings.forEach(b=>{
    if(excludeId!=null && b.id===excludeId) return;
    const poly = b.points;
    if(!poly || poly.length<2) return;
    poly.forEach(v=>{
      const d = Math.hypot(v.x-pt.x, v.z-pt.z);
      if(d<bestVertexDist){ bestVertexDist=d; bestVertex={x:v.x, z:v.z}; }
    });
    for(let i=0;i<poly.length;i++){
      const a=poly[i], c=poly[(i+1)%poly.length];
      const proj = closestPointOnSegment(pt,a,c);
      const d = Math.hypot(proj.x-pt.x, proj.z-pt.z);
      if(d<bestEdgeDist){ bestEdgeDist=d; bestEdge=proj; }
    }
  });
  return bestVertex || bestEdge || null;
}
// Résout la position d'un point posé pendant le tracé d'un NOUVEAU bâtiment :
// priorité à l'aimantation sur un bâtiment voisin, sinon comportement habituel
// (sommets/bords de la parcelle constructible, ou simple clamp dedans).
function resolveNewBuildingPoint(pt){
  const otherSnap = snapPointToOtherBuildings(pt);
  if(otherSnap) return buildZone.length>=3 ? clampPointToPolygon(otherSnap, buildZone) : otherSnap;
  return buildZone.length>=3 ? snapPointToZone(pt, buildZone) : pt;
}
export function flashStatus(msg, isAlert){
  const statusLine = document.getElementById('status-line');
  statusLine.dataset.orig = statusLine.dataset.orig || statusLine.textContent;
  statusLine.innerHTML = `<b>${msg}</b>`;
  statusLine.classList.toggle('is-alert', !!isAlert);
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(()=>{ statusLine.textContent = statusLine.dataset.orig; statusLine.classList.remove('is-alert'); }, 1800);
}
// Contour de référence pour aimanter les sommets pendant le TRACÉ d'un
// nouveau volume supérieur (pas pendant l'édition d'un décroché existant,
// voir editTargetBelowFootprint pour ce cas-là) : le sommet actuel du
// bâtiment ciblé.
function volumeDrawBelowFootprint(){
  if(volumeDrawTargetId===null) return null;
  const b = buildings.find(x=>x.id===volumeDrawTargetId);
  return b ? footprintForBand(b, b.bands[b.bands.length-1]) : null;
}
function addDrawPoint(pt){
  // Aimantation directe sur un sommet/bord du polygone si on clique à
  // proximité — même mécanisme fiable que "Emprise pleine" (copie/projection
  // exacte des coordonnées, jamais un point "presque" dessus). Pour un volume
  // supérieur, on aimante sur le contour du volume INFÉRIEUR (pas la zone
  // d'implantation au sol) — pour que les façades continues restent
  // parfaitement alignées d'un décroché à l'autre, sans décalage parasite.
  const belowFootprint = volumeDrawBelowFootprint();
  const target = belowFootprint ? snapToFootprintEdges(pt, belowFootprint)
    : ((!volumeDrawTargetId && buildZone.length>=3) ? resolveNewBuildingPoint(pt) : pt);
  // Étape 2 : hugue IMMÉDIATEMENT le segment reliant le point précédent à
  // celui-ci contre le bord réel du polygone — pas seulement à la fermeture
  // du tracé (finishDraw). Ainsi le contour est correct dès la pose, sans
  // avoir à "valider" pour voir la marge fantôme disparaître. Un volume
  // supérieur se trace librement sur le toit, sans accrochage au sol.
  let toInsert;
  if(!volumeDrawTargetId && buildZone.length>=3 && drawPoints.length>0){
    const from = drawPoints[drawPoints.length-1];
    toInsert = repairEdgeAgainstZone(from, target, buildZone, drawPoints);
  } else {
    toInsert = [{x:target.x, z:target.z}];
  }
  toInsert.forEach(p=>{
    drawPoints.push({x:p.x, z:p.z});
    // Rayon unitaire : la taille réelle à l'écran est recalculée chaque
    // frame par updateScreenSizedMarkers() pour rester constante au zoom.
    const m = new THREE.Mesh(new THREE.SphereGeometry(1,14,14), new THREE.MeshBasicMaterial({color:0xe0663f}));
    m.position.set(p.x,0.2,p.z);
    drawMarkers.add(m);
    registerScreenSizedMarker(m);
  });
  refreshPreview();
}
function finishDraw(){
  if(drawPoints.length<3){ cancelDraw(); return; }
  // Répare la dernière arête (celle qui referme le contour, du dernier point
  // posé vers le premier) puis nettoie les doublons/points quasi confondus
  // qu'un hug répété peut laisser — mais ne réordonne JAMAIS les points : le
  // contour doit rester exactement dans l'ordre où il a été tracé.
  // NB : un volume supérieur se dessine sur le toit, hors du polygone
  // d'implantation au sol — pas de "hug" contre buildZone dans ce cas.
  let finalPoints = drawPoints.slice();
  if(!volumeDrawTargetId && buildZone.length>=3 && finalPoints.length>=2){
    const first = finalPoints[0], last = finalPoints[finalPoints.length-1];
    const closing = repairEdgeAgainstZone(last, first, buildZone, finalPoints);
    // le dernier point de "closing" == first ; on ne le rajoute pas (il ferme déjà la boucle)
    finalPoints = finalPoints.concat(closing.slice(0, -1));
  }
  finalPoints = cleanPolygonPoints(finalPoints) || finalPoints;
  finalPoints = simplifyClosedPolygon(finalPoints) || finalPoints;
  if(finalPoints.length<3){ cancelDraw(); return; }
  if(volumeDrawTargetId!==null){
    const targetBuilding = buildings.find(x=>x.id===volumeDrawTargetId);
    cancelDraw();
    if(targetBuilding) askVolumeFloorsThenBuild(targetBuilding, finalPoints);
    return;
  }
  cancelDraw();
  askFloorsThenBuild(finalPoints);
}

/* ------------------------------------------------------------
   Modale "nombre d'étages" affichée juste après le tracé d'un nouveau
   bâtiment : plus de construction directe à 6 étages par défaut, l'usager
   choisit le nombre d'étages désiré avant que la construction (animée)
   ne démarre.
   ------------------------------------------------------------ */
const floorsModalOverlay = document.getElementById('floors-modal-overlay');
const floorsModalInput = document.getElementById('floors-modal-input');
function askFloorsThenBuild(finalPoints){
  floorsModalInput.value = 6;
  floorsModalOverlay.classList.remove('hidden');
  if(window.lucide) lucide.createIcons();
  function clampVal(){ return Math.max(1, Math.min(getMaxBuildingFloors(), parseInt(floorsModalInput.value)||6)); }
  function cleanup(){
    floorsModalOverlay.classList.add('hidden');
    document.getElementById('floors-modal-minus').removeEventListener('click', onMinus);
    document.getElementById('floors-modal-plus').removeEventListener('click', onPlus);
    document.getElementById('floors-modal-validate').removeEventListener('click', onValidate);
    document.getElementById('floors-modal-cancel').removeEventListener('click', onCancel);
  }
  function onMinus(){ floorsModalInput.value = clampVal()-1<1?1:clampVal()-1; }
  function onPlus(){ floorsModalInput.value = clampVal()+1>getMaxBuildingFloors()?getMaxBuildingFloors():clampVal()+1; }
  function onValidate(){
    const floors = clampVal();
    cleanup();
    const b = createBuilding(finalPoints, { floors, silent:true });
    // Les arbres plantés sous l'emprise ne sont retirés qu'ICI, une fois la
    // construction réellement validée par l'utilisateur (voir l'aperçu rouge
    // pendant le tracé dans updateTreesOverlapPreview).
    Trees.removeTreesUnderFootprint(finalPoints);
    setSelectedId(b.id);
    renderList();
    startBuildingConstruction(b);
  }
  function onCancel(){ cleanup(); }
  document.getElementById('floors-modal-minus').addEventListener('click', onMinus);
  document.getElementById('floors-modal-plus').addEventListener('click', onPlus);
  document.getElementById('floors-modal-validate').addEventListener('click', onValidate);
  document.getElementById('floors-modal-cancel').addEventListener('click', onCancel);
}

/* ------------------------------------------------------------
   VOLUMES SUPÉRIEURS — tracé d'un "décroché" sur le toit d'un bâtiment
   existant. Réutilise la machine de tracé polygone/rectangle ci-dessus
   (drawing/drawPoints/drawMode/finishDraw), simplement redirigée vers le
   toit via volumeDrawTargetId (voir groundPointFromEvent).
   ------------------------------------------------------------ */
export function startVolumeDraw(b){
  if(treePlacing) Trees.stopTreeTool();
  if(amenagementPlacing) Amenagements.stopAmenagementsTool();
  if(grassPainting) Grass.stopGrassTool();
  if(labelPlacing) Labels.stopLabelTool();
  ExtGare.cancelExtensionGareIfActive();
  if(editingBuildingId) stopEditBuildingShape();
  volumeDrawTargetId = b.id;
  volumeDrawRoofY = buildingTotalHeight(b);
  drawMode = 'polygon';
  drawing = true; drawPoints = [];
  AppState.setDrawing(drawing);
  clearMarkers();
  showVolumeRoofGrid(b);
  // Tracé bien plus facile bloqué en vue plan (orthographique, du dessus),
  // recentrée sur CE bâtiment — sinon la perspective déforme sa silhouette
  // et fausse le jugement du débord de 30% pendant le tracé.
  lockPlanViewForVolumeDraw(b);
  drawHintText.textContent = 'Cliquez sur le toit pour poser les sommets du volume supérieur';
  drawHintEnter.style.display = '';
  drawHint.classList.add('show');
  enterConstructionMode();
  applyConstructionGrayscale(b.group);
  refreshBldgMiniListVisibility();
}

function askVolumeFloorsThenBuild(b, finalPoints){
  document.querySelector('#floors-modal h3').textContent = "Volume supérieur — nombre d'étages";
  document.querySelector('#floors-modal p').textContent = "Choisissez le nombre d'étages de ce volume (modifiable ensuite depuis sa fiche).";
  document.getElementById('floors-modal-validate').textContent = 'Ajouter';
  floorsModalInput.value = 3;
  floorsModalOverlay.classList.remove('hidden');
  if(window.lucide) lucide.createIcons();
  function clampVal(){ return Math.max(1, Math.min(getMaxBuildingFloors(), parseInt(floorsModalInput.value)||3)); }
  function restoreModalText(){
    document.querySelector('#floors-modal h3').textContent = "Nombre d'étages";
    document.querySelector('#floors-modal p').textContent = "Choisissez le nombre d'étages du bâtiment avant sa construction (modifiable ensuite à tout moment).";
    document.getElementById('floors-modal-validate').textContent = 'Construire';
  }
  function cleanup(){
    floorsModalOverlay.classList.add('hidden');
    restoreModalText();
    document.getElementById('floors-modal-minus').removeEventListener('click', onMinus);
    document.getElementById('floors-modal-plus').removeEventListener('click', onPlus);
    document.getElementById('floors-modal-validate').removeEventListener('click', onValidate);
    document.getElementById('floors-modal-cancel').removeEventListener('click', onCancel);
  }
  function onMinus(){ floorsModalInput.value = clampVal()-1<1?1:clampVal()-1; }
  function onPlus(){ floorsModalInput.value = clampVal()+1>getMaxBuildingFloors()?getMaxBuildingFloors():clampVal()+1; }
  function onValidate(){
    const floors = clampVal();
    cleanup();
    addVolumeToBuilding(b, finalPoints, floors);
  }
  function onCancel(){ cleanup(); }
  document.getElementById('floors-modal-minus').addEventListener('click', onMinus);
  document.getElementById('floors-modal-plus').addEventListener('click', onPlus);
  document.getElementById('floors-modal-validate').addEventListener('click', onValidate);
  document.getElementById('floors-modal-cancel').addEventListener('click', onCancel);
}

function addVolumeToBuilding(b, pts, floors){
  let cleaned = cleanPolygonPoints(pts) || pts;
  // La référence du débord, c'est le sommet ACTUEL du bâtiment (la dernière
  // tranche déjà posée), pas toujours le socle — pour empiler plusieurs
  // décrochés en escalier, chacun comparé à celui juste en dessous de lui.
  const belowBand = b.bands[b.bands.length-1];
  const belowFootprint = footprintForBand(b, belowBand);
  const before = polygonOutsideAreaRatio(cleaned, belowFootprint);
  cleaned = shrinkPolygonToFitOverlap(cleaned, belowFootprint, 0.30);
  if(before > 0.30) flashStatus('Volume ajusté : débord ramené à 30% maximum', true);
  // Le nombre d'étages de CE volume reste plafonné à 30 (un décroché reste un
  // décroché, pas un second gratte-ciel), et le TOTAL du bâtiment ne dépasse
  // jamais MAX_BUILDING_FLOORS non plus (garde-fou de bon sens, voir sa
  // définition) — sans jamais retomber en dessous de ce qui existe déjà.
  const maxFloors = getMaxBuildingFloors();
  const extraFloors = Math.max(1, Math.min(30, maxFloors - b.floors, floors||1));
  const newFrom = b.floors + 1;
  b.floors = b.floors + extraFloors;
  // Nouvelle tranche au sommet, avec SON PROPRE contour (le décroché) — un
  // seul et même compteur d'étages pour tout le bâtiment, donc surface et
  // répartition des usages restent automatiquement exactes.
  b.bands.push({ from:newFrom, to:b.floors, usage: belowBand.usage || DEFAULT_USAGE, points: cleaned, facadeMotif: belowBand.facadeMotif || getDefaultMotif(), facadeTint: belowBand.facadeTint || getDefaultFacadeTint() });
  normalizeBands(b);
  rebuildMesh(b);
  renderList();
  setSelectedId(b.id);
  openBldgEditWindow(b.id);
}

// ---------- Grille de repère flottante au-dessus du toit, pendant le tracé
// d'un volume supérieur — s'estompe progressivement vers les bords (dégradé
// radial en alpha) pour ne pas trancher visuellement avec la scène. ----------
let volumeRoofGridMesh = null;
let volumeRoofOutline = null;
function makeFadedGridTexture(){
  const size = 512, c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,size,size);
  ctx.strokeStyle = `rgba(${NEON_BLUE_CSS},0.9)`;
  ctx.lineWidth = 1.5;
  const step = size/16;
  for(let i=0;i<=16;i++){
    const p = i*step;
    ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(size,p); ctx.stroke();
  }
  // Fondu radial vers les bords : on applique un masque alpha (destination-in)
  // avec un dégradé plein au centre, transparent sur les bords.
  ctx.globalCompositeOperation = 'destination-in';
  const grad = ctx.createRadialGradient(size/2,size/2,0, size/2,size/2,size/2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,size,size);
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}
function showVolumeRoofGrid(b){
  hideVolumeRoofGrid();
  // Repère sur le sommet ACTUEL du bâtiment (dernière tranche déjà posée) —
  // c'est cette emprise-là qui sert de référence pour la règle des 30%.
  const footprint = footprintForBand(b, b.bands[b.bands.length-1]);
  const xs = footprint.map(p=>p.x), zs = footprint.map(p=>p.z);
  const w = Math.max(...xs)-Math.min(...xs), d = Math.max(...zs)-Math.min(...zs);
  const cx = (Math.max(...xs)+Math.min(...xs))/2, cz = (Math.max(...zs)+Math.min(...zs))/2;
  const span = Math.max(w,d) * 1.6 + 6; // marge au-delà de l'emprise pour bien voir où on peut déborder
  const roofY = buildingTotalHeight(b);
  const geo = new THREE.PlaneGeometry(span, span);
  const mat = new THREE.MeshBasicMaterial({
    map: makeFadedGridTexture(), transparent:true, depthWrite:false,
    side:THREE.DoubleSide
  });
  volumeRoofGridMesh = new THREE.Mesh(geo, mat);
  volumeRoofGridMesh.rotation.x = -Math.PI/2;
  volumeRoofGridMesh.position.set(cx, roofY+0.05, cz);
  volumeRoofGridMesh.renderOrder = 2;
  worldRoot.add(volumeRoofGridMesh);
  // Contour du toit actuel (référence des 30% de débord max), bien visible.
  const outlinePts = footprint.map(p=>new THREE.Vector3(p.x, roofY+0.08, p.z));
  outlinePts.push(outlinePts[0].clone());
  volumeRoofOutline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(outlinePts),
    new THREE.LineBasicMaterial({ color:NEON_BLUE, transparent:true, opacity:0.9, depthTest:false })
  );
  volumeRoofOutline.renderOrder = 3;
  worldRoot.add(volumeRoofOutline);
}
function hideVolumeRoofGrid(){
  if(volumeRoofOutline){ worldRoot.remove(volumeRoofOutline); volumeRoofOutline.geometry.dispose(); volumeRoofOutline.material.dispose(); volumeRoofOutline=null; }
  if(!volumeRoofGridMesh) return;
  worldRoot.remove(volumeRoofGridMesh);
  volumeRoofGridMesh.geometry.dispose();
  volumeRoofGridMesh.material.map.dispose();
  volumeRoofGridMesh.material.dispose();
  volumeRoofGridMesh = null;
}

btnDraw.addEventListener('click', ()=>{
  if(drawing){ cancelDraw(); return; }
  if(!drawMenuOpen){
    if(treePlacing) Trees.stopTreeTool();
    if(amenagementPlacing) Amenagements.stopAmenagementsTool();
    if(grassPainting) Grass.stopGrassTool();
    if(labelPlacing) Labels.stopLabelTool();
    ExtGare.cancelExtensionGareIfActive();
  }
  drawMenuOpen ? closeDrawMenu() : openDrawMenu();
});
btnModePoly.addEventListener('click', ()=>{ closeDrawMenu(); startDraw('polygon'); });
btnModeRect.addEventListener('click', ()=>{ closeDrawMenu(); startDraw('rect'); });

// Câblage différé dans wireDrawClickHandler()/wireDrawPointerDownHandler()/
// wireDrawPointerMoveHandler(), appelées par initDrawTool() : au moment où ce
// module est évalué, renderer est encore null (imports statiques évalués
// avant le corps du script d'index.html qui le crée).
function wireDrawClickHandler(){
renderer.domElement.addEventListener('click', (ev)=>{
  if(!drawing || drawMode!=='polygon') return;
  const pt = groundPointFromEvent(ev);
  if(pt) addDrawPoint(pt);
});
}
window.addEventListener('keydown', (ev)=>{
  if(!drawing) return;
  if(ev.key==='Enter' && drawMode==='polygon') finishDraw();
  if(ev.key==='Escape') cancelDraw();
});
// Tente de valider un déplacement/pivot en cours : refuse (message d'erreur)
// si le bâtiment dépasse encore le polygone d'implantation. Utilisé par le
// bouton VALIDER du bandeau ET le bouton "Terminer" du panneau bâtiment.
export function tryValidateMove(){
  const b = buildings.find(x=>x.id===getMovingBuildingId());
  if(b && buildingExceedsZone(b)){
    flashStatus('Hors du polygone d\'implantation — ramenez le bâtiment dans la parcelle avant de valider', true);
    return false;
  }
  // Comme pour un nouveau tracé (voir point 4) : les arbres sous l'emprise
  // ne sont retirés qu'à la validation effective du déplacement, pas avant.
  if(b) Trees.removeTreesUnderFootprint(b.points);
  stopMoveBuilding();
  return true;
}
document.getElementById('btn-construction-validate').addEventListener('click', ()=>{
  if(getMovingBuildingId()){ tryValidateMove(); return; }
  if(!drawing) return;
  if(drawMode==='polygon') finishDraw(); // le rectangle se valide déjà tout seul au relâchement de la souris
});
document.getElementById('btn-construction-cancel').addEventListener('click', ()=>{
  if(getMovingBuildingId()){ cancelMoveBuilding(); return; }
  if(drawing) cancelDraw();
});

// ---- Mode rectangle : cliquer-glisser-lâcher trace un rectangle au sol,
// contraint au polygone d'implantation via le même pipeline (finishDraw) que
// le mode polygone — aucune duplication de la logique de réparation de bord.
function wireDrawPointerDownHandler(){
renderer.domElement.addEventListener('pointerdown', (ev)=>{
  if(!drawing || drawMode!=='rect' || ev.button!==0) return;
  const pt = groundPointFromEvent(ev);
  if(!pt) return;
  const belowFootprint = volumeDrawBelowFootprint();
  const start = belowFootprint ? snapToFootprintEdges(pt, belowFootprint)
    : ((!volumeDrawTargetId && buildZone.length>=3) ? resolveNewBuildingPoint(pt) : pt);
  rectDragging = true;
  rectStartPt = {x:start.x, z:start.z};
  drawPoints = [{x:rectStartPt.x, z:rectStartPt.z}];
  refreshPreview();
});
}
function wireDrawPointerMoveHandler(){
renderer.domElement.addEventListener('pointermove', (ev)=>{
  if(!drawing || drawMode!=='rect' || !rectDragging) return;
  const pt = groundPointFromEvent(ev);
  if(!pt) return;
  const belowFootprint = volumeDrawBelowFootprint();
  const snapped = belowFootprint ? snapToFootprintEdges(pt, belowFootprint)
    : (!volumeDrawTargetId ? resolveNewBuildingPoint(pt) : pt);
  const x0=rectStartPt.x, z0=rectStartPt.z, x1=snapped.x, z1=snapped.z;
  drawPoints = [ {x:x0,z:z0}, {x:x1,z:z0}, {x:x1,z:z1}, {x:x0,z:z1} ];
  refreshPreview();
});
}
window.addEventListener('pointerup', ()=>{
  if(!drawing || drawMode!=='rect' || !rectDragging) return;
  rectDragging = false;
  const tooSmall = drawPoints.length<4 ||
    (Math.hypot(drawPoints[0].x-drawPoints[2].x, drawPoints[0].z-drawPoints[2].z) < 1);
  if(tooSmall){ drawPoints = []; clearMarkers(); return; }
  finishDraw();
});
