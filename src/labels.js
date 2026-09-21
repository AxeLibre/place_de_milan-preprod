// OUTIL LABELS — point au sol + étiquette décalée + ligne de rappel, extrait
// d'index.html.
//
// Le point 3D (petite sphère) fait partie de la scène WebGL, donc il
// apparaît automatiquement dans le rendu ET dans l'export PNG. L'étiquette
// texte et la ligne de rappel, elles, vivent en HTML/SVG par-dessus le
// canvas — nécessaire pour un anti-chevauchement dynamique fluide (mesure
// réelle de la largeur du texte, recalcul à chaque frame selon la caméra).
// Comme ces calques HTML n'apparaissent PAS automatiquement dans un export
// canvas.toDataURL(), l'export PNG (resté dans index.html) les redessine à
// la main sur un canvas hors-écran à partir des mêmes coordonnées ici
// calculées (l.anchorX/Y, l.screenX/Y).

import * as THREE from "three";
import {
  camera, controls, renderer, worldRoot, orthoCamera, buildZone, buildings,
  planViewActive, drawing, drawMenuOpen, editingBuildingId, treePlacing, amenagementPlacing,
  grassPainting, pointer, raycaster,
} from './state.js';
import * as AppState from './state.js';
import { clampPointToPolygon, pointInPolygon } from './geometry-utils.js';
import { NEON_BLUE, NEON_BLUE_CSS } from './config.js';
import * as ExtGare from './extension-gare.js';
import * as Trees from './trees.js';
import * as Amenagements from './amenagements.js';
import * as Grass from './grass.js';

// Dépendances pas encore extraites (outil de tracé, édition de bâtiment...),
// injectées une fois par initLabels().
let cancelDraw, closeDrawMenu, stopEditBuildingShape, flashStatus, makeCircleDecal;

export function initLabels(deps){
  ({ cancelDraw, closeDrawMenu, stopEditBuildingShape, flashStatus, makeCircleDecal } = deps);
  // Câblage différé jusqu'ici plutôt qu'au chargement du module : worldRoot et
  // renderer (depuis state.js) sont encore null au moment où ce module ES est
  // évalué (les imports statiques s'exécutent avant le corps du script
  // d'index.html, qui les crée) — voir le commentaire équivalent dans trees.js.
  worldRoot.add(labelGroup);
  wireLabelClickHandler();
  wireLabelPointerMoveHandler();
}

export let labels = [];
AppState.setLabels(labels);
let labelIdCounter = 1;
let labelsVisible = true;
AppState.setLabelsVisible(labelsVisible);

export function getLabelsVisible(){ return labelsVisible; }
export function setLabelsVisible(v){
  labelsVisible = v;
  AppState.setLabelsVisible(v);
  labelGroup.visible = v;
  updateLabelPositions();
}

// Mode de pose : 'ground' (au sol, comportement d'origine) ou 'building'
// (collé sur une face ou un toit de bâtiment — socle ou volume supérieur,
// peu importe : on raycast directement contre les meshes réels du bâtiment,
// donc ça marche identiquement pour les deux).
let labelMode = 'ground';
let labelPlacing = false;
AppState.setLabelPlacing(labelPlacing);
const labelGroup = new THREE.Group(); // ajouté à worldRoot dans initLabels() (voir commentaire là-bas)
AppState.setLabelGroup(labelGroup);
const labelLayer = document.getElementById('label-layer');
const labelLinesSvg = document.getElementById('label-lines');
const btnLabel = document.getElementById('btn-label');
const labelModePopout = document.getElementById('label-mode-popout');
const labelModeBtns = {
  ground: document.getElementById('label-mode-ground'),
  building: document.getElementById('label-mode-building'),
};
function setLabelMode(mode){
  labelMode = mode;
  Object.entries(labelModeBtns).forEach(([k,btn])=> btn.classList.toggle('active', k===mode));
}
labelModeBtns.ground.addEventListener('click', ()=> setLabelMode('ground'));
labelModeBtns.building.addEventListener('click', ()=> setLabelMode('building'));
function positionLabelModePopout(){
  const r = btnLabel.getBoundingClientRect();
  labelModePopout.style.left = (r.right + 8) + 'px';
  labelModePopout.style.top = r.top + 'px';
}
window.addEventListener('resize', ()=>{ if(labelPlacing) positionLabelModePopout(); });

export function addLabel(x, z, text, opts={}){
  const id = labelIdCounter++;
  const locked = !!opts.locked;
  const onBuilding = !!opts.onBuilding;
  // Hauteur du point d'ancrage : 0.3 au-dessus du sol par défaut (labels
  // classiques), sinon l'altitude EXACTE du point cliqué sur la façade/le
  // toit (voir buildingSurfaceHitFromEvent) — c'est ce qui permet à un label
  // "bâtiment" de rester posé en hauteur, pile sur la surface visée.
  const y = opts.y!==undefined ? opts.y : 0.3;
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.5,12,12),
    new THREE.MeshBasicMaterial({color: locked ? 0x8a8f96 : NEON_BLUE})
  );
  marker.position.set(x, y, z);
  labelGroup.add(marker);

  const chip = document.createElement('div');
  chip.className = 'label-chip' + (onBuilding ? ' on-building' : '');
  if(locked) chip.classList.add('locked');
  chip.textContent = text;
  const isAdminNow = document.body.classList.contains('is-admin');
  chip.title = locked
    ? (isAdminNow ? 'Label ADMIN (depart.json) — Cliquer : modifier · Cliquer-glisser : déplacer · Clic droit : supprimer · pensez à "Enregistrer depart.json"' : 'Label existant (non modifiable) — masquable via l\'œil du panneau')
    : 'Cliquer : modifier · Cliquer-glisser : déplacer';
  labelLayer.appendChild(chip);

  const line = document.createElementNS('http://www.w3.org/2000/svg','line');
  line.setAttribute('stroke', locked ? 'rgba(138,143,150,.65)' : `rgba(${NEON_BLUE_CSS},.65)`);
  line.setAttribute('stroke-width', '1.2');
  line.setAttribute('stroke-dasharray', '2,3');
  labelLinesSvg.appendChild(line);

  const rec = { id, x, y, z, text, marker, chip, line, anchorX:0, anchorY:0, screenX:0, screenY:0, behind:false, locked, onBuilding };
  wireLabelChipInteractions(rec);
  labels.push(rec);
  updateLabelPositions();
  return rec;
}
// Cliquer-glisser-déposer pour déplacer un label sur le sol, simple clic
// (sans déplacement) pour ouvrir la modale d'édition de son texte.
let labelDrag = null; // {rec, moved}
function wireLabelChipInteractions(rec){
  // Labels de départ (depart.json, rec.locked=true) : verrouillés pour les
  // visiteurs (ni déplaçables, ni éditables, ni supprimables — seul l'œil
  // global les masque), mais l'ADMIN doit pouvoir les modifier et les
  // réenregistrer (bouton "Enregistrer depart.json"), sinon toute correction
  // serait perdue au prochain remplacement du fichier depart.json.
  if(rec.locked && !document.body.classList.contains('is-admin')) return;
  rec.chip.addEventListener('contextmenu', (ev)=>{
    ev.preventDefault();
    if(rec.locked && !document.body.classList.contains('is-admin')) return;
    removeLabel(rec.id);
  });
  rec.chip.addEventListener('pointerdown', (ev)=>{
    if(ev.button!==0) return;
    ev.stopPropagation();
    labelDrag = { rec, moved:false };
    rec.chip.setPointerCapture(ev.pointerId);
    rec.chip.classList.add('dragging');
  });
  rec.chip.addEventListener('pointermove', (ev)=>{
    if(!labelDrag || labelDrag.rec!==rec) return;
    labelDrag.moved = true;
    const pt = Trees.siteGroundHitFromEvent(ev);
    if(!pt) return;
    let target = pt;
    const isAdmin = document.body.classList.contains('is-admin');
    if(!isAdmin && buildZone.length>=3) target = clampPointToPolygon(pt, buildZone);
    rec.x = target.x; rec.z = target.z; rec.y = 0.3;
    // Un glissement se fait toujours au sol : un label "bâtiment" qu'on
    // déplace ainsi redevient un label au sol classique (pastille ronde).
    if(rec.onBuilding){ rec.onBuilding = false; rec.chip.classList.remove('on-building'); }
    rec.marker.position.set(rec.x, rec.y, rec.z);
    updateLabelPositions();
  });
  rec.chip.addEventListener('pointerup', (ev)=>{
    if(!labelDrag || labelDrag.rec!==rec) return;
    rec.chip.releasePointerCapture(ev.pointerId);
    rec.chip.classList.remove('dragging');
    const moved = labelDrag.moved;
    labelDrag = null;
    if(!moved) openLabelEditModal(rec);
  });
}
export function removeLabel(id){
  const idx = labels.findIndex(l=>l.id===id);
  if(idx<0) return;
  const l = labels[idx];
  labelGroup.remove(l.marker); l.marker.geometry.dispose(); l.marker.material.dispose();
  l.chip.remove(); l.line.remove();
  labels.splice(idx,1);
}

// ------------------------------------------------------------
// Sauvegarde / chargement (JSON projet) : remplace intégralement les labels
// NON verrouillés (les labels ADMIN verrouillés, issus de depart.json, ne
// sont pas inclus dans les sauvegardes de projet — on ne touche donc pas à
// eux ici, pour ne pas les faire disparaître au chargement).
// ------------------------------------------------------------
export function loadLabels(dataLabels){
  labels.filter(l=>!l.locked).forEach(l=> removeLabel(l.id));
  labels = labels.filter(l=>l.locked);
  AppState.setLabels(labels);
  (dataLabels||[]).forEach(l=> addLabel(l.x, l.z, l.text, { y:l.y, onBuilding:l.onBuilding }));
}

const _labelProjVec = new THREE.Vector3();
export function updateLabelPositions(){
  if(!labels.length) return;
  const rect = renderer.domElement.getBoundingClientRect();
  if(!rect.width || !rect.height) return;
  const activeCam = planViewActive ? orthoCamera : camera;
  const placedRects = [];
  labels.forEach(l=>{
    _labelProjVec.set(l.x, l.y!==undefined ? l.y : 0.3, l.z).project(activeCam);
    const behind = _labelProjVec.z > 1;
    const sx = (_labelProjVec.x*0.5+0.5) * rect.width;
    const sy = (1-(_labelProjVec.y*0.5+0.5)) * rect.height;
    l.anchorX = sx; l.anchorY = sy; l.behind = behind;
    if(behind || !labelsVisible){
      l.chip.style.display = 'none'; l.line.style.display = 'none';
      return;
    }
    l.chip.style.display = ''; l.line.style.display = '';
    // Position de base : décalée en haut-à-droite du point, puis repoussée
    // vers le bas si elle chevauche une étiquette déjà placée cette frame —
    // évite la superposition sans jamais cacher un label sous un autre.
    const w = l.chip.offsetWidth || 60, h = l.chip.offsetHeight || 22;
    let cx = sx + 22, cy = sy - 18;
    let tries = 0;
    while(tries < 40){
      const r = { left:cx-w/2, right:cx+w/2, top:cy-h, bottom:cy };
      const overlap = placedRects.some(o => !(r.right<o.left || r.left>o.right || r.bottom<o.top || r.top>o.bottom));
      if(!overlap) break;
      cy += h+4; tries++;
    }
    placedRects.push({ left:cx-w/2, right:cx+w/2, top:cy-h, bottom:cy });
    l.chip.style.left = cx+'px'; l.chip.style.top = cy+'px';
    l.screenX = cx; l.screenY = cy - h/2;
    l.line.setAttribute('x1', sx); l.line.setAttribute('y1', sy);
    l.line.setAttribute('x2', cx); l.line.setAttribute('y2', cy - h*0.3);
  });
}
export function stopLabelTool(){
  labelPlacing = false;
  AppState.setLabelPlacing(labelPlacing);
  btnLabel.classList.remove('active');
  if(labelPlantHalo) labelPlantHalo.visible = false;
  if(labelSurfaceHalo) labelSurfaceHalo.visible = false;
  labelModePopout.classList.remove('show');
}
btnLabel.addEventListener('click', ()=>{
  if(!labelPlacing){
    // Comme les autres outils : n'en garder qu'un seul actif à la fois.
    if(drawing) cancelDraw();
    if(drawMenuOpen) closeDrawMenu();
    if(treePlacing) Trees.stopTreeTool();
    if(amenagementPlacing) Amenagements.stopAmenagementsTool();
    if(grassPainting) Grass.stopGrassTool();
    ExtGare.cancelExtensionGareIfActive();
    if(editingBuildingId) stopEditBuildingShape();
  }
  labelPlacing = !labelPlacing;
  AppState.setLabelPlacing(labelPlacing);
  btnLabel.classList.toggle('active', labelPlacing);
  if(labelPlacing){
    positionLabelModePopout();
    labelModePopout.classList.add('show');
  } else {
    labelModePopout.classList.remove('show');
  }
  flashStatus(labelPlacing
    ? (labelMode==='building'
        ? "Cliquez sur une façade ou un toit de bâtiment pour y coller un label (Échap pour annuler)"
        : "Cliquez sur la maquette pour poser un label (Échap pour annuler)")
    : 'Pose de label annulée');
});
window.addEventListener('keydown', (ev)=>{
  if(ev.key==='Escape' && labelPlacing) stopLabelTool();
});
// Raycast contre les VRAIS meshes des bâtiments (socle ET volumes
// supérieurs — tous logés dans le même b.group, voir rebuildMesh) : renvoie
// le point 3D exact d'impact sur une façade ou un toit, à sa vraie hauteur.
function buildingSurfaceHitFromEvent(ev){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  buildings.forEach(b=> b.group.children.forEach(o=>{ if(o.isMesh) meshes.push(o); }));
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit ? hit.point : null;
}
// Câblage différé (voir initLabels()) : au moment où ce module est évalué,
// renderer est encore null (imports statiques évalués avant le corps du
// script d'index.html).
function wireLabelClickHandler(){
renderer.domElement.addEventListener('click', (ev)=>{
  if(!labelPlacing) return;
  if(labelMode==='building'){
    const hit = buildingSurfaceHitFromEvent(ev);
    if(!hit){ flashStatus("Cliquez sur une façade ou un toit de bâtiment pour y coller un label", true); return; }
    stopLabelTool();
    openLabelEditModal(null, { x:hit.x, y:hit.y, z:hit.z, onBuilding:true });
    return;
  }
  const pt = Trees.siteGroundHitFromEvent(ev);
  if(!pt){ flashStatus("Cliquez sur la maquette pour poser un label"); return; }
  const isAdmin = document.body.classList.contains('is-admin');
  if(!isAdmin && buildZone.length>=3 && !pointInPolygon({x:pt.x, z:pt.z}, buildZone)){
    flashStatus("Les labels ne peuvent être posés que dans le polygone d'implantation", true);
    return;
  }
  stopLabelTool();
  openLabelEditModal(null, pt);
});
}

/* ------------------------------------------------------------
   Repère pendant la pose d'un label :
   - mode "sol" : décalque au sol, même mécanisme que le halo de plantation
     des arbres (ensureTreePlantHalo) — bleu si le point est dans le polygone
     d'implantation (pose autorisée), rouge sinon.
   - mode "bâtiment" : petite sphère qui suit le point d'impact EXACT sur la
     façade/le toit visé (pas de notion d'autorisé/refusé ici : n'importe
     quelle surface de bâtiment convient).
   ------------------------------------------------------------ */
const LABEL_PLANT_COLOR = NEON_BLUE_CSS;
const LABEL_BLOCKED_COLOR = '224,71,63';
let labelPlantHalo = null;
function ensureLabelPlantHalo(){
  if(labelPlantHalo) return labelPlantHalo;
  labelPlantHalo = makeCircleDecal(1.4, LABEL_PLANT_COLOR, 'fill');
  labelPlantHalo.position.y = 0.05;
  labelPlantHalo.visible = false;
  worldRoot.add(labelPlantHalo);
  return labelPlantHalo;
}
let labelSurfaceHalo = null;
function ensureLabelSurfaceHalo(){
  if(labelSurfaceHalo) return labelSurfaceHalo;
  labelSurfaceHalo = new THREE.Mesh(
    new THREE.SphereGeometry(0.55,14,14),
    new THREE.MeshBasicMaterial({ color:NEON_BLUE, depthTest:false, transparent:true, opacity:0.9 })
  );
  labelSurfaceHalo.renderOrder = 50;
  labelSurfaceHalo.visible = false;
  worldRoot.add(labelSurfaceHalo);
  return labelSurfaceHalo;
}
// Câblage différé (voir wireLabelClickHandler() ci-dessus / initLabels()).
function wireLabelPointerMoveHandler(){
renderer.domElement.addEventListener('pointermove', (ev)=>{
  if(!labelPlacing){
    if(labelPlantHalo) labelPlantHalo.visible = false;
    if(labelSurfaceHalo) labelSurfaceHalo.visible = false;
    return;
  }
  if(labelMode==='building'){
    if(labelPlantHalo) labelPlantHalo.visible = false;
    ensureLabelSurfaceHalo();
    const hit = buildingSurfaceHitFromEvent(ev);
    if(!hit){ labelSurfaceHalo.visible = false; return; }
    labelSurfaceHalo.position.copy(hit);
    labelSurfaceHalo.visible = true;
    return;
  }
  if(labelSurfaceHalo) labelSurfaceHalo.visible = false;
  ensureLabelPlantHalo();
  const pt = Trees.siteGroundHitFromEvent(ev);
  if(!pt){ labelPlantHalo.visible = false; return; }
  const isAdmin = document.body.classList.contains('is-admin');
  const ok = isAdmin || buildZone.length<3 || pointInPolygon({x:pt.x, z:pt.z}, buildZone);
  labelPlantHalo.material.color.set(ok ? `rgb(${LABEL_PLANT_COLOR})` : `rgb(${LABEL_BLOCKED_COLOR})`);
  labelPlantHalo.position.set(pt.x, (pt.y||0)+0.05, pt.z);
  labelPlantHalo.visible = true;
});
}

/* ------------------------------------------------------------
   MODALE D'ÉDITION DE LABEL — remplace window.prompt() par une modale au
   design du site. Sert aussi bien à la création (rec=null, pos fourni)
   qu'à l'édition d'un label existant (rec fourni).
   ------------------------------------------------------------ */
const labelEditOverlay = document.getElementById('label-edit-overlay');
const labelEditTitle = document.getElementById('label-edit-title');
const labelEditInput = document.getElementById('label-edit-input');
const labelEditDelete = document.getElementById('label-edit-delete');
let labelEditState = null; // {rec, pos}
function openLabelEditModal(rec, pos){
  labelEditState = { rec, pos };
  labelEditTitle.firstChild.textContent = rec ? (rec.locked ? 'Modifier le label ADMIN ' : 'Modifier le label ') : 'Nouveau label ';
  labelEditInput.value = rec ? rec.text : '';
  labelEditDelete.style.display = rec ? '' : 'none';
  labelEditOverlay.classList.add('show');
  if(window.lucide) lucide.createIcons();
  setTimeout(()=>{ labelEditInput.focus(); labelEditInput.select(); }, 30);
}
function closeLabelEditModal(){
  labelEditOverlay.classList.remove('show');
  labelEditState = null;
}
function saveLabelEditModal(){
  if(!labelEditState) return;
  const text = labelEditInput.value.trim();
  const { rec, pos } = labelEditState;
  if(!text){ closeLabelEditModal(); return; }
  if(rec){
    rec.text = text;
    rec.chip.textContent = text;
  } else if(pos){
    // Un point venant du mode "bâtiment" porte `onBuilding` et sa hauteur
    // exacte d'impact ; un point du mode "sol" (Vector3 brut) garde le
    // comportement d'origine : marqueur légèrement flottant à 0.3m (défaut
    // d'addLabel), pas la hauteur brute du raycast au sol.
    addLabel(pos.x, pos.z, text, pos.onBuilding ? { y: pos.y, onBuilding: true } : {});
  }
  closeLabelEditModal();
}
document.getElementById('label-edit-save').addEventListener('click', saveLabelEditModal);
document.getElementById('label-edit-cancel').addEventListener('click', closeLabelEditModal);
document.getElementById('label-edit-close').addEventListener('click', closeLabelEditModal);
labelEditDelete.addEventListener('click', ()=>{
  if(labelEditState && labelEditState.rec) removeLabel(labelEditState.rec.id);
  closeLabelEditModal();
});
labelEditOverlay.addEventListener('click', (e)=>{ if(e.target===labelEditOverlay) closeLabelEditModal(); });
labelEditInput.addEventListener('keydown', (ev)=>{
  if(ev.key==='Enter'){ ev.preventDefault(); saveLabelEditModal(); }
  else if(ev.key==='Escape'){ ev.preventDefault(); closeLabelEditModal(); }
});
