// OUTIL AMÉNAGEMENTS — pose d'éléments de mobilier urbain/paysager (fontaine,
// lampadaire...) contenus dans assets.glb, strictement à l'intérieur du
// polygone d'implantation.
//
// Comportement (calqué sur les outils Arbre et Déplacer un bâtiment) :
//  - le bouton "Aménagements" ouvre un menu d'assets ; choisir un asset
//    l'arme : un aperçu translucide suit la souris (halo bleu au sol), un
//    clic gauche le pose, et l'outil reste armé pour en poser d'autres ;
//  - hors du polygone d'implantation, l'aperçu passe au rouge, le polygone se
//    borde d'un contour rouge en tirets (même effet que le déplacement d'un
//    bâtiment) et la pose est refusée ;
//  - survoler un aménagement déjà posé l'entoure d'un halo bleu ; un clic
//    gauche le "reprend" (il suit alors la souris jusqu'au prochain clic) ;
//  - clic droit : rotation (glisser = rotation continue, simple clic = pas de
//    15°), sur l'aperçu, sur l'aménagement repris, ou sur celui qu'on survole ;
//  - Suppr : supprime l'aménagement repris ou survolé ; Échap : annule la
//    reprise en cours, puis quitte l'outil.
//
// Le lampadaire est en DEUX parties dans assets.glb : le mât (maillage
// "lampadaire_mat") et la lumière (nœud "lampadaire_lumiere", dont seule la
// POSITION est reprise). Chaque lampadaire posé reçoit son mât et s'inscrit
// comme source du pool de lumières de nuit (src/night-lights.js) — pas de
// PointLight propre : ajouter une lumière visible recompile tous les
// matériaux (la pose ramait). Le nombre de lampadaires reste plafonné à
// MAX_LAMPADAIRES.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  camera, orthoCamera, controls, renderer, worldRoot, buildZone, planViewActive,
  pointer, raycaster, drawing, drawMenuOpen, treePlacing, grassPainting,
  labelPlacing, editingBuildingId, amenagementPlacing,
} from './state.js';
import * as AppState from './state.js';
import { pointInPolygon } from './geometry-utils.js';
import { NEON_BLUE_CSS } from './config.js';
import * as ExtGare from './extension-gare.js';
import * as Trees from './trees.js';
import * as NightLights from './night-lights.js';

export const MAX_LAMPADAIRES = 10;
const ASSETS_URL = './assets.glb';
const ROTATE_SENSITIVITY = 0.008;   // radians par pixel de glissement horizontal (clic droit)
const ROTATE_STEP = Math.PI/12;     // simple clic droit : 15°
const RIGHT_CLICK_DRAG_PX = 4;      // au-delà, le clic droit est un glissement, pas un simple clic
const INVALID_COLOR = 0xff2d2d;
const HALO_RENDER_ORDER = 5;        // au-dessus du gazon peint (voir trees.js, TREE_GUIDE_RENDER_ORDER)
const LAMP_LIGHT = { intensity:18, distance:110, decay:1.1 }; // mêmes réglages que les lampadaires de la maquette (voir collectSiteLights)

// Catalogue du menu. `nodes` = noms des nœuds racine de assets.glb qui
// composent l'asset ; `shape` = forme de l'emprise au sol testée contre le
// polygone d'implantation (cercle ou rectangle englobant, calculés depuis le
// modèle lui-même).
const ASSET_DEFS = [
  { id:'fontaine',   label:'Fontaine',   icon:'fluent-emoji-flat:fountain',  node:'fontaine',       shape:'circle', max:Infinity },
  { id:'lampadaire', label:'Lampadaire', icon:'fluent-emoji-flat:light-bulb', node:'lampadaire_mat', lightNode:'lampadaire_lumiere', shape:'rect', max:MAX_LAMPADAIRES },
];
const defOf = id => ASSET_DEFS.find(d=>d.id===id);

// Dépendances pas encore extraites d'index.html, injectées par initAmenagements()
// (même principe que initTrees()).
let cancelDraw, closeDrawMenu, stopTreeTool, stopGrassTool, stopLabelTool,
    stopEditBuildingShape, stopMoveBuilding, getMovingBuildingId, flashStatus,
    makeCircleDecal, showZoneOverflowOutline, hideZoneOverflowOutline,
    getGrassParts, getIsNight;
export function initAmenagements(deps){
  ({
    cancelDraw, closeDrawMenu, stopTreeTool, stopGrassTool, stopLabelTool,
    stopEditBuildingShape, stopMoveBuilding, getMovingBuildingId, flashStatus,
    makeCircleDecal, showZoneOverflowOutline, hideZoneOverflowOutline,
    getGrassParts, getIsNight,
  } = deps);
  worldRoot.add(amenagementsGroup);
  wireHandlers();
  buildMenu();
}

const amenagementsGroup = new THREE.Group(); amenagementsGroup.name = 'amenagementsGroup';
AppState.setAmenagementsGroup(amenagementsGroup);
let visibleFlag = true;
export function getAmenagementsVisible(){ return visibleFlag; }
export function setAmenagementsVisible(v){ visibleFlag = v; amenagementsGroup.visible = v; }

export let amenagements = []; // { id, type, group, x, y, z, rot, light }
let idCounter = 1;
let nightOn = false;
// Appelée par index.html à chaque bascule jour/nuit (et par
// refreshNightLighting) : (dés)allume les lumières ponctuelles des lampadaires.
export function setNightState(on){
  nightOn = !!on;
  amenagements.forEach(a=>{ if(a.light) a.light.visible = nightOn; });
}
export function countOf(type){ return amenagements.filter(a=>a.type===type).length; }

/* ------------------------------------------------------------
   Chargement de assets.glb (au premier besoin) et gabarits
   ------------------------------------------------------------ */
let templates = null;       // id -> { object: Group, lightOffset: Vector3|null, footprint: [{x,z}], haloRadius }
let templatesPromise = null;
function ensureAssetsLoaded(){
  if(templates) return Promise.resolve(templates);
  if(templatesPromise) return templatesPromise;
  templatesPromise = new Promise((resolve, reject)=>{
    new GLTFLoader().load(ASSETS_URL, (gltf)=>{
      try{ templates = buildTemplates(gltf.scene); resolve(templates); }
      catch(err){ templatesPromise = null; reject(err); }
    }, undefined, (err)=>{ templatesPromise = null; reject(err); });
  });
  return templatesPromise;
}
function buildTemplates(sceneRoot){
  sceneRoot.updateMatrixWorld(true);
  const out = {};
  ASSET_DEFS.forEach(def=>{
    const node = sceneRoot.getObjectByName(def.node);
    if(!node) throw new Error(`nœud "${def.node}" introuvable dans ${ASSETS_URL}`);
    const wrapper = new THREE.Group();
    const inner = node.clone(true);
    // Le nœud est posé à l'origine (sa position/rotation dans assets.glb ne
    // sont que celles de la mise en page du fichier) ; son échelle est
    // conservée (la fontaine est mise à l'échelle dans le fichier).
    inner.position.set(0,0,0);
    inner.quaternion.identity();
    wrapper.add(inner);
    wrapper.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(wrapper);
    let footprint, haloRadius;
    if(def.shape === 'circle'){
      const cx = (bb.min.x+bb.max.x)/2, cz = (bb.min.z+bb.max.z)/2;
      const r = Math.max(bb.max.x-bb.min.x, bb.max.z-bb.min.z)/2;
      footprint = [];
      for(let i=0;i<24;i++){ const a = i/24*Math.PI*2; footprint.push({ x:cx+Math.cos(a)*r, z:cz+Math.sin(a)*r }); }
      haloRadius = r*1.12;
    } else {
      const pad = 0.15;
      const x0 = bb.min.x-pad, x1 = bb.max.x+pad, z0 = bb.min.z-pad, z1 = bb.max.z+pad;
      const xm = (x0+x1)/2, zm = (z0+z1)/2;
      footprint = [{x:x0,z:z0},{x:xm,z:z0},{x:x1,z:z0},{x:x1,z:zm},{x:x1,z:z1},{x:xm,z:z1},{x:x0,z:z1},{x:x0,z:zm}];
      haloRadius = Math.max(1.6, Math.hypot(bb.max.x-bb.min.x, bb.max.z-bb.min.z)*0.9);
    }
    let lightOffset = null;
    if(def.lightNode){
      const ln = sceneRoot.getObjectByName(def.lightNode);
      if(ln) lightOffset = ln.getWorldPosition(new THREE.Vector3());
    }
    out[def.id] = { object: wrapper, lightOffset, footprint, haloRadius };
  });
  return out;
}

/* ------------------------------------------------------------
   Instances
   ------------------------------------------------------------ */
function cloneMaterials(obj){
  obj.traverse(o=>{
    if(!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    // clone(true) ne clone PAS les matériaux (partagés avec le gabarit et donc
    // entre toutes les instances) : on les clone pour que la teinte rouge
    // d'avertissement d'un aménagement n'affecte jamais les autres.
    o.material = Array.isArray(o.material) ? o.material.map(m=>m.clone()) : o.material.clone();
  });
}
function materialsOf(obj){
  const out = [];
  obj.traverse(o=>{ if(o.isMesh && o.material) (Array.isArray(o.material)?o.material:[o.material]).forEach(m=> m && out.push(m)); });
  return out;
}
function tintInvalid(obj, invalid){
  materialsOf(obj).forEach(m=>{
    if(!m.userData._am) m.userData._am = {
      color: m.color ? m.color.clone() : null,
      emissive: m.emissive ? m.emissive.clone() : null,
      emissiveIntensity: m.emissiveIntensity,
    };
    const st = m.userData._am;
    if(invalid){
      if(m.color) m.color.setHex(INVALID_COLOR);
      if(m.emissive){ m.emissive.setHex(INVALID_COLOR); m.emissiveIntensity = 0.7; }
    } else {
      if(m.color && st.color) m.color.copy(st.color);
      if(m.emissive && st.emissive){ m.emissive.copy(st.emissive); m.emissiveIntensity = st.emissiveIntensity; }
    }
  });
}
function buildObject(type){
  const tpl = templates[type];
  const obj = tpl.object.clone(true);
  cloneMaterials(obj);
  return obj;
}

function addAmenagement(type, x, y, z, rot, opts){
  opts = opts || {};
  const tpl = templates[type];
  const group = buildObject(type);
  group.position.set(x, y, z);
  group.rotation.y = rot;
  amenagementsGroup.add(group);
  const rec = { id: idCounter++, type, group, x, y, z, rot, light:null };
  amenagements.push(rec);
  // La lumière du lampadaire (2e partie de l'asset, après le mât) n'est PLUS une
  // PointLight propre à chaque lampadaire : ajouter/retirer une lumière visible
  // recompile tous les matériaux de la scène (c'était ce qui faisait ramer la
  // pose). Le lampadaire s'inscrit comme "source" du pool de lumières de nuit
  // (src/night-lights.js), qui n'a qu'un nombre fixe de vraies lumières.
  syncLamp(rec);
  refreshMenu();
  return rec;
}
// Position monde (repère de worldRoot) de la lumière d'un lampadaire, sous le
// bras du mât : décalage local de assets.glb, tourné avec le lampadaire.
const _lampPos = new THREE.Vector3();
function syncLamp(rec){
  const tpl = templates[rec.type];
  if(!tpl || !tpl.lightOffset) return;
  _lampPos.copy(tpl.lightOffset).applyAxisAngle(new THREE.Vector3(0,1,0), rec.rot).add(rec.group.position);
  const id = 'am:' + rec.id;
  NightLights.registerSource(id, _lampPos, { color:0xffe4f2, intensity:LAMP_LIGHT.intensity, distance:LAMP_LIGHT.distance, decay:LAMP_LIGHT.decay });
}
function removeAmenagement(rec){
  if(!rec) return;
  NightLights.unregisterSource('am:' + rec.id);
  amenagementsGroup.remove(rec.group);
  materialsOf(rec.group).forEach(m=> m.dispose());
  amenagements = amenagements.filter(a=>a!==rec);
  if(carrying === rec) resetCarrying();
  if(hoverRec === rec) hoverRec = null;
  refreshMenu();
}
export function clearAllAmenagements(){
  amenagements.slice().forEach(removeAmenagement);
}

/* ------------------------------------------------------------
   Sauvegarde / chargement (JSON projet)
   ------------------------------------------------------------ */
export function serializeAmenagements(){
  return amenagements.map(a=>({ type:a.type, x:a.x, y:a.y, z:a.z, rot:a.rot }));
}
export function loadAmenagements(list){
  clearAllAmenagements();
  const items = (list||[]).filter(it=> it && defOf(it.type));
  if(!items.length) return Promise.resolve();
  return ensureAssetsLoaded().then(()=>{
    items.forEach(it=>{
      // Le plafond de lampadaires vaut aussi pour un fichier de projet.
      const def = defOf(it.type);
      if(countOf(it.type) >= def.max) return;
      addAmenagement(it.type, it.x, it.y||0, it.z, it.rot||0);
    });
  }).catch(err=> console.warn('[Place de Milan] Aménagements non chargés :', err));
}

/* ------------------------------------------------------------
   Validité : toute l'emprise de l'asset (tournée) dans le polygone
   ------------------------------------------------------------ */
function footprintInside(type, x, z, rot){
  if(buildZone.length < 3) return true;
  const tpl = templates[type];
  const c = Math.cos(rot), s = Math.sin(rot);
  return tpl.footprint.every(p=>{
    // rotation d'axe Y de three.js : x' = x·cos + z·sin ; z' = −x·sin + z·cos
    const wx = x + p.x*c + p.z*s, wz = z - p.x*s + p.z*c;
    return pointInPolygon({x:wx, z:wz}, buildZone, 0.03);
  });
}

/* ------------------------------------------------------------
   Interface : bouton, menu, indications
   ------------------------------------------------------------ */
const btnAmenagements = document.getElementById('btn-amenagements');
const popout = document.getElementById('amenagements-popout');
const menuList = document.getElementById('amenagements-menu-list');
const btnClearAll = document.getElementById('btn-clear-amenagements');
const drawHint = document.getElementById('draw-hint');
const drawHintText = document.getElementById('draw-hint-text');
const drawHintEnter = document.getElementById('draw-hint-enter');
const menuItems = {}; // id -> { btn, countEl }
function buildMenu(){
  menuList.innerHTML = '';
  ASSET_DEFS.forEach(def=>{
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'amenagement-item';
    btn.title = def.max !== Infinity ? `${def.label} — limité à ${def.max} sur la maquette` : def.label;
    btn.innerHTML = `<iconify-icon icon="${def.icon}" width="24" height="24"></iconify-icon><span class="am-label">${def.label}</span><span class="am-count"></span>`;
    btn.addEventListener('click', ()=> onMenuPick(def.id));
    menuList.appendChild(btn);
    menuItems[def.id] = { btn, countEl: btn.querySelector('.am-count') };
  });
  btnClearAll.addEventListener('click', ()=>{
    if(!amenagements.length) return;
    clearAllAmenagements();
    flashStatus('Aménagements supprimés');
  });
  refreshMenu();
}
function refreshMenu(){
  ASSET_DEFS.forEach(def=>{
    const it = menuItems[def.id]; if(!it) return;
    const n = countOf(def.id);
    it.countEl.textContent = def.max !== Infinity ? `${n}/${def.max}` : (n ? String(n) : '');
    it.btn.classList.toggle('disabled', n >= def.max);
    it.btn.classList.toggle('active', armedType === def.id);
  });
  if(btnClearAll) btnClearAll.style.display = amenagements.length ? '' : 'none';
}
function positionPopout(){
  const r = btnAmenagements.getBoundingClientRect();
  popout.style.left = (r.right + 8) + 'px';
  popout.style.top = r.top + 'px';
}
window.addEventListener('resize', ()=>{ if(amenagementPlacing) positionPopout(); });

const HINT_ARMED = "Clic gauche : poser · Clic droit : pivoter · Clic sur un aménagement : le déplacer · Suppr : supprimer · Échap : quitter";
const HINT_IDLE = "Choisissez un aménagement dans le menu · Clic sur un aménagement posé : le déplacer · Suppr : supprimer · Échap : quitter";
const HINT_CARRY = "Clic gauche : poser ici · Clic droit : pivoter · Suppr : supprimer · Échap : annuler le déplacement";
function setHint(text){ drawHintText.textContent = text; }
function currentHint(){ return carrying ? HINT_CARRY : (armedType ? HINT_ARMED : HINT_IDLE); }
function setViolation(exceeds){
  if(exceeds){ showZoneOverflowOutline(); } else { hideZoneOverflowOutline(); }
  drawHint.classList.toggle('zone-error', exceeds);
  setHint(exceeds ? "⚠ Hors du polygone d'implantation — impossible de poser ici" : currentHint());
}

/* ------------------------------------------------------------
   État de l'outil
   ------------------------------------------------------------ */
let armedType = null;        // asset choisi dans le menu (aperçu + pose), ou null
let ghost = null;            // { type, obj, invalid }
let carrying = null;         // aménagement repris (rec), suit la souris
let carryOrigin = null;      // { x, y, z, rot } avant la reprise, pour Échap
let carryInvalid = false;
let hoverRec = null;         // aménagement survolé
let lastPtr = null;          // dernier point sol survolé { x, y, z }
let ghostRot = 0;            // rotation courante de l'aperçu (conservée entre deux poses)
let rotDrag = null;          // { startX, startRot, moved, target }
let blueHalo = null, redHalo = null;

function ensureHalos(){
  if(blueHalo) return;
  blueHalo = makeCircleDecal(1, NEON_BLUE_CSS, 'fill');
  redHalo = makeCircleDecal(1, '255,64,64', 'fill');
  [blueHalo, redHalo].forEach(h=>{ h.renderOrder = HALO_RENDER_ORDER; h.visible = false; worldRoot.add(h); });
}
function showHalo(kind, x, y, z, radius){
  ensureHalos();
  const on = kind==='red' ? redHalo : blueHalo, off = kind==='red' ? blueHalo : redHalo;
  off.visible = false;
  on.visible = true;
  on.position.set(x, y + 0.05, z);
  on.scale.setScalar(radius);
}
function hideHalos(){ if(blueHalo){ blueHalo.visible = false; redHalo.visible = false; } }

function ensureGhost(type){
  if(ghost && ghost.type === type) return ghost;
  removeGhost();
  const obj = buildObject(type);
  obj.traverse(o=>{
    if(!o.isMesh) return;
    o.castShadow = false; o.receiveShadow = false;
    o.renderOrder = HALO_RENDER_ORDER;
    (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{
      m.transparent = true; m.opacity = 0.6; m.depthWrite = false;
    });
  });
  obj.visible = false;
  amenagementsGroup.add(obj);
  ghost = { type, obj, invalid:false };
  return ghost;
}
function removeGhost(){
  if(!ghost) return;
  amenagementsGroup.remove(ghost.obj);
  materialsOf(ghost.obj).forEach(m=> m.dispose());
  ghost = null;
}
function resetCarrying(){
  carrying = null; carryOrigin = null; carryInvalid = false;
}

function updateCursor(){
  const c = carrying ? 'grabbing' : hoverRec ? 'grab' : (armedType && ghost && ghost.obj.visible) ? 'copy' : '';
  renderer.domElement.style.cursor = c;
}

/* ------------------------------------------------------------
   Ouverture / fermeture de l'outil
   ------------------------------------------------------------ */
export function startAmenagementsTool(){
  if(amenagementPlacing) return;
  if(drawing) cancelDraw();
  if(drawMenuOpen) closeDrawMenu();
  if(treePlacing) stopTreeTool();
  if(grassPainting) stopGrassTool();
  if(labelPlacing) stopLabelTool();
  if(editingBuildingId) stopEditBuildingShape();
  if(getMovingBuildingId()) stopMoveBuilding();
  ExtGare.cancelExtensionGareIfActive();
  AppState.setAmenagementPlacing(true);
  btnAmenagements.classList.add('active');
  controls.enabled = false;
  drawHintEnter.style.display = 'none';
  drawHint.classList.add('show');
  setHint(HINT_IDLE);
  popout.classList.add('show');
  positionPopout();
  refreshMenu();
  // Précharge assets.glb dès l'ouverture du menu (petit fichier) : l'aperçu
  // est alors immédiat au premier choix d'un asset.
  ensureAssetsLoaded().catch(err=>{
    console.warn('[Place de Milan] assets.glb impossible à charger :', err);
    flashStatus("Impossible de charger assets.glb — vérifiez qu'il est à côté de index.html", true);
  });
}
export function stopAmenagementsTool(){
  if(carrying) cancelCarry(true);
  AppState.setAmenagementPlacing(false);
  armedType = null;
  removeGhost();
  hideHalos();
  hoverRec = null; lastPtr = null; rotDrag = null;
  hideZoneOverflowOutline();
  btnAmenagements.classList.remove('active');
  drawHint.classList.remove('show', 'zone-error');
  drawHintEnter.style.display = '';
  controls.enabled = true;
  renderer.domElement.style.cursor = '';
  popout.classList.remove('show');
  refreshMenu();
}
function onMenuPick(id){
  const def = defOf(id);
  if(!def) return;
  if(armedType === id){ // reclic sur l'asset armé : on le désarme
    armedType = null; removeGhost(); hideHalos(); setViolation(false); refreshMenu(); updateCursor();
    return;
  }
  if(countOf(id) >= def.max){
    flashStatus(`Limite de ${def.max} ${def.label.toLowerCase()}s atteinte — supprimez-en un pour en poser un autre`, true);
    return;
  }
  ensureAssetsLoaded().then(()=>{
    if(!amenagementPlacing) return;
    if(carrying) cancelCarry(false);
    armedType = id;
    ensureGhost(id);
    setHint(HINT_ARMED);
    refreshMenu();
    if(lastPtr) updateGhostAt(lastPtr);
  }).catch(()=> flashStatus("Impossible de charger assets.glb", true));
}
btnAmenagements.addEventListener('click', ()=> amenagementPlacing ? stopAmenagementsTool() : startAmenagementsTool());
window.addEventListener('keydown', (ev)=>{
  if(!amenagementPlacing) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if(tag==='INPUT' || tag==='TEXTAREA') return;
  if(ev.key === 'Escape'){
    if(carrying) cancelCarry(false); else stopAmenagementsTool();
  } else if(ev.key === 'Delete' || ev.key === 'Backspace'){
    const target = carrying || hoverRec;
    if(target){ ev.preventDefault(); removeAmenagement(target); setViolation(false); hideHalos(); updateCursor(); flashStatus('Aménagement supprimé'); }
  }
});

/* ------------------------------------------------------------
   Reprise / pose d'un aménagement existant
   ------------------------------------------------------------ */
function startCarry(rec){
  carrying = rec;
  carryOrigin = { x:rec.x, y:rec.y, z:rec.z, rot:rec.rot };
  carryInvalid = false;
  hoverRec = null;
  if(ghost) ghost.obj.visible = false;
  setHint(HINT_CARRY);
  updateCursor();
}
// `quiet` : pas de remise à jour du texte d'aide (appelé depuis stopAmenagementsTool).
function cancelCarry(quiet){
  if(!carrying) return;
  const rec = carrying;
  const o = carryOrigin;
  rec.x = o.x; rec.y = o.y; rec.z = o.z; rec.rot = o.rot;
  rec.group.position.set(o.x, o.y, o.z);
  rec.group.rotation.y = o.rot;
  syncLamp(rec);
  tintInvalid(rec.group, false);
  resetCarrying();
  hideHalos();
  hideZoneOverflowOutline();
  drawHint.classList.remove('zone-error');
  if(!quiet){ setHint(currentHint()); updateCursor(); }
}
function moveCarriedTo(pt){
  const rec = carrying;
  rec.x = pt.x; rec.y = pt.y; rec.z = pt.z;
  rec.group.position.set(pt.x, pt.y, pt.z);
  syncLamp(rec);
  revalidateCarried();
}
function revalidateCarried(){
  const rec = carrying; if(!rec) return;
  const invalid = !footprintInside(rec.type, rec.x, rec.z, rec.rot);
  if(invalid !== carryInvalid){ tintInvalid(rec.group, invalid); carryInvalid = invalid; }
  setViolation(invalid);
  showHalo(invalid ? 'red' : 'blue', rec.x, rec.y, rec.z, templates[rec.type].haloRadius);
}
function updateGhostAt(pt){
  if(!ghost) return;
  ghost.obj.visible = true;
  ghost.obj.position.set(pt.x, pt.y, pt.z);
  ghost.obj.rotation.y = ghostRot;
  revalidateGhost(pt);
}
function revalidateGhost(pt){
  if(!ghost) return;
  const invalid = !footprintInside(ghost.type, pt.x, pt.z, ghostRot);
  if(invalid !== ghost.invalid){ tintInvalid(ghost.obj, invalid); ghost.invalid = invalid; }
  setViolation(invalid);
  showHalo(invalid ? 'red' : 'blue', pt.x, pt.y, pt.z, templates[ghost.type].haloRadius);
}

/* ------------------------------------------------------------
   Souris
   ------------------------------------------------------------ */
function activeCamera(){ return planViewActive ? orthoCamera : camera; }
function setPointerFromEvent(ev){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, activeCamera());
}
function pickPlaced(ev){
  setPointerFromEvent(ev);
  const hit = raycaster.intersectObjects(amenagements.map(a=>a.group), true)[0];
  if(!hit) return null;
  let obj = hit.object;
  while(obj && !amenagements.some(a=>a.group===obj)) obj = obj.parent;
  return amenagements.find(a=>a.group===obj) || null;
}
function groundPoint(ev){
  const p = Trees.siteGroundHitFromEvent(ev, activeCamera());
  return p ? { x:p.x, y:p.y, z:p.z } : null;
}
function rotationTarget(){
  if(carrying) return { kind:'carry', rec:carrying };
  if(hoverRec) return { kind:'placed', rec:hoverRec };
  if(ghost && ghost.obj.visible) return { kind:'ghost' };
  return null;
}
function applyRotation(target, rot){
  if(target.kind === 'ghost'){
    ghostRot = rot;
    if(lastPtr) updateGhostAt(lastPtr);
  } else if(target.kind === 'carry'){
    target.rec.rot = rot;
    target.rec.group.rotation.y = rot;
    syncLamp(target.rec);
    revalidateCarried();
  } else {
    // Aménagement posé qu'on survole : on refuse une rotation qui ferait
    // sortir son emprise du polygone d'implantation (il resterait posé hors
    // périmètre, contrairement à toute règle de l'outil).
    const rec = target.rec;
    if(!footprintInside(rec.type, rec.x, rec.z, rot)){
      flashStatus("Cette rotation ferait sortir l'aménagement du polygone d'implantation", true);
      return false;
    }
    rec.rot = rot;
    rec.group.rotation.y = rot;
    syncLamp(rec);
  }
  return true;
}
function currentRotation(target){
  return target.kind === 'ghost' ? ghostRot : target.rec.rot;
}

function wireHandlers(){
  const el = renderer.domElement;

  el.addEventListener('pointermove', (ev)=>{
    if(!amenagementPlacing || !templates) return;
    if(rotDrag){
      const dx = ev.clientX - rotDrag.startX;
      if(Math.abs(dx) > RIGHT_CLICK_DRAG_PX) rotDrag.moved = true;
      if(rotDrag.moved) applyRotation(rotDrag.target, rotDrag.startRot + dx*ROTATE_SENSITIVITY);
      return;
    }
    if(carrying){
      const pt = groundPoint(ev);
      if(pt){ lastPtr = pt; moveCarriedTo(pt); }
      return;
    }
    // Un aménagement posé sous le curseur prime sur la pose d'un nouveau
    // (comme pour un arbre existant) : halo bleu dessus, prêt à être repris.
    const over = pickPlaced(ev);
    if(over){
      hoverRec = over;
      if(ghost) ghost.obj.visible = false;
      setViolation(false);
      showHalo('blue', over.x, over.y, over.z, templates[over.type].haloRadius);
      updateCursor();
      return;
    }
    hoverRec = null;
    const pt = groundPoint(ev);
    if(pt) lastPtr = pt;
    if(armedType && pt){
      updateGhostAt(pt);
    } else {
      if(ghost) ghost.obj.visible = false;
      hideHalos(); setViolation(false);
    }
    updateCursor();
  });

  el.addEventListener('pointerdown', (ev)=>{
    if(!amenagementPlacing || ev.button !== 2) return;
    const target = rotationTarget();
    if(!target) return;
    ev.preventDefault();
    rotDrag = { startX: ev.clientX, startRot: currentRotation(target), moved:false, target };
    el.setPointerCapture(ev.pointerId);
  });
  el.addEventListener('pointerup', (ev)=>{
    if(!rotDrag || ev.button !== 2) return;
    const d = rotDrag; rotDrag = null;
    if(el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    // Simple clic droit (sans glissement) : rotation d'un pas de 15°.
    if(!d.moved) applyRotation(d.target, d.startRot + ROTATE_STEP);
  });
  // Pas de menu contextuel du navigateur sur la scène pendant l'outil : le
  // clic droit sert à pivoter.
  el.addEventListener('contextmenu', (ev)=>{ if(amenagementPlacing) ev.preventDefault(); });

  el.addEventListener('click', (ev)=>{
    if(!amenagementPlacing || !templates) return;
    if(carrying){
      if(carryInvalid){ flashStatus("Hors du polygone d'implantation — impossible de poser ici", true); return; }
      const rec = carrying;
      resetCarrying();
      hideHalos(); setViolation(false);
      showHalo('blue', rec.x, rec.y, rec.z, templates[rec.type].haloRadius);
      hoverRec = rec;
      setHint(currentHint());
      updateCursor();
      return;
    }
    const over = pickPlaced(ev);
    if(over){ startCarry(over); showHalo('blue', over.x, over.y, over.z, templates[over.type].haloRadius); return; }
    if(!armedType) return;
    const pt = groundPoint(ev);
    if(!pt){ flashStatus("Cliquez dans le polygone d'implantation", true); return; }
    if(!footprintInside(armedType, pt.x, pt.z, ghostRot)){
      flashStatus("Les aménagements ne peuvent être posés que dans le polygone d'implantation", true);
      return;
    }
    const def = defOf(armedType);
    if(countOf(armedType) >= def.max){
      flashStatus(`Limite de ${def.max} ${def.label.toLowerCase()}s atteinte`, true);
      armedType = null; removeGhost(); hideHalos(); refreshMenu(); return;
    }
    addAmenagement(armedType, pt.x, pt.y, pt.z, ghostRot);
    if(countOf(armedType) >= def.max){
      // Dernier exemplaire autorisé posé : on désarme l'outil pour ne pas
      // laisser un aperçu qui ne pourra plus être posé.
      flashStatus(`${def.label} : limite de ${def.max} atteinte`);
      armedType = null; removeGhost(); hideHalos(); setViolation(false); refreshMenu(); updateCursor();
    }
  });
}
