// OUTIL ARBRES — plantation contrainte au polygone d'implantation, extrait
// d'index.html.
//
// PERFORMANCE : tous les arbres (plantés à la main ET chargés en masse depuis
// trees.json) partagent désormais un pool de THREE.InstancedMesh (un par
// partie du gabarit — tronc/feuillage) au lieu d'un THREE.Object3D cloné par
// arbre. Mesuré : 500 arbres en clones individuels = +473 draw calls et
// +11 ms/image ; 3000 arbres en instances = +2 draw calls et coût quasi nul.
// Le gabarit visuel reste cloné du premier objet "Icosphère*" trouvé dans la
// maquette chargée (repli sur un icosaèdre généré si absent, ex. en mode
// démo) — IMPORTANT : au moins UN objet "Icosphère*" doit rester présent
// dans le .glb, même après avoir exporté tous les autres en trees.json,
// sinon il n'y a plus de forme à instancier (voir le script Blender fourni,
// blender/export_trees_json.py).
//
// Deux catégories d'arbres, mêmes rendu/API que l'existant pour l'usage
// interactif :
//  - "plantés"  (locked:false, valeur par défaut) : ceux posés à la main avec
//    l'outil, ou listés dans depart.json — comptés/effaçables/sauvegardés
//    exactement comme avant (aucun changement de comportement).
//  - "de scène" (locked:true) : chargés en masse depuis trees.json (arbres
//    d'origine du décor, ex. "Icosphère.xxx" de la maquette globale) — non
//    cliquables pour suppression, absents de "Supprimer tous les arbres", du
//    compteur du panneau et des sauvegardes de projet (même principe que les
//    labels ADMIN verrouillés, voir labels.js). Ils restent en revanche
//    supprimés automatiquement s'ils tombent sous l'emprise d'un nouveau
//    bâtiment (removeTreesUnderFootprint), comme n'importe quel arbre — un
//    conflit physique réel, indépendant du verrouillage.
//
// Contient aussi les boules "sphère" posées aux coins convexes du toit des
// nouveaux bâtiments (gabarit/logique voisins de ceux des arbres, non
// instanciées — un petit nombre par bâtiment, sans enjeu de performance),
// ainsi que siteGroundHitFromEvent — réutilisé par l'outil Label (pas encore
// extrait) pour un raycast fidèle sur les vraies surfaces de la maquette
// (gazon, quartier, hall, sol), plutôt qu'un simple plan invisible.

import * as THREE from "three";
import {
  camera, controls, renderer, worldRoot, siteRoot, globalRoot, buildZone,
  quartierGroup, hallMesh, ground, pointer, raycaster, drawing, drawMenuOpen,
  grassPainting, labelPlacing, editingBuildingId,
} from './state.js';
import * as AppState from './state.js';
import { pointInPolygon } from './geometry-utils.js';
import { NEON_BLUE_CSS } from './config.js';
import * as ExtGare from './extension-gare.js';

// Dépendances pas encore extraites (outil de tracé, outil Gazon, outil
// Label, édition de bâtiment, stats du panneau...), injectées une fois par
// initTrees() — voir le commentaire équivalent dans camera-architect.js.
let cancelDraw, closeDrawMenu, stopGrassTool, stopLabelTool, stopEditBuildingShape,
    flashStatus, updateSiteStats, makeCircleDecal, getGrassParts,
    getDrawMode, getRectDragging, getRectStartPt, getDrawPoints, getVolumeDrawTargetId;

export function initTrees(deps){
  ({
    cancelDraw, closeDrawMenu, stopGrassTool, stopLabelTool, stopEditBuildingShape,
    flashStatus, updateSiteStats, makeCircleDecal, getGrassParts,
    getDrawMode, getRectDragging, getRectStartPt, getDrawPoints, getVolumeDrawTargetId,
  } = deps);
  // Câblage différé jusqu'ici (plutôt qu'au chargement du module) : au moment
  // où ce module ES est évalué, ses imports statiques (dont worldRoot/renderer
  // depuis state.js) s'exécutent tous AVANT le corps du script d'index.html —
  // donc AVANT que celui-ci ait créé/enregistré worldRoot ou renderer. Tenter
  // worldRoot.add(...) ou renderer.domElement.addEventListener(...) au niveau
  // racine du module lèverait "Cannot read properties of null". initTrees()
  // n'est en revanche appelée par index.html qu'une fois tout ça prêt.
  worldRoot.add(treesGroup);
  wireTreeClickHandler();
  wireTreePointerMoveHandler();
}

let treeTemplate = null; // {object: THREE.Group, baseScale}
function findIcosphereTemplate(){
  // IMPORTANT : quand un objet Blender a plusieurs matériaux (ex. tronc + feuillage),
  // l'export glTF le scinde en PLUSIEURS primitives, et THREE.GLTFLoader charge ça
  // comme un Group (le noeud "Icosphère.NNN") contenant DEUX Mesh enfants — pas un
  // seul Mesh multi-matériaux. En cherchant uniquement `o.isMesh`, on ne récupérait
  // que le premier enfant rencontré (le tronc), d'où le feuillage manquant : ce
  // n'était pas un problème de matériau cassé, mais un sous-arbre entier ignoré.
  // On cherche donc le premier noeud (Mesh OU Group) dont le nom matche, et on
  // clone TOUT son sous-arbre.
  let found = null;
  siteRoot.traverse(o=>{ if(!found && /icosph/i.test(o.name||'')) found = o; });
  if(!found && globalRoot) globalRoot.traverse(o=>{ if(!found && /icosph/i.test(o.name||'')) found = o; });
  if(found){
    const inner = found.clone(true); // clone profond (tronc + feuillage), géométrie/matériaux partagés par référence
    inner.position.set(0,0,0);
    inner.rotation.set(0,0,0);
    inner.scale.set(1,1,1);
    // (treesGroup vit maintenant sous worldRoot, comme la maquette : plus besoin
    // de recorriger manuellement l'axe ici, la rotation Z-up→Y-up est héritée
    // automatiquement via la hiérarchie.)
    inner.updateMatrixWorld(true);
    // Recentre sur sa propre base locale (X/Z centrés, Y=0 au point le plus bas) :
    // indispensable si l'export a "appliqué" la position mondiale dans les sommets.
    const bb = new THREE.Box3().setFromObject(inner);
    const cx = (bb.min.x+bb.max.x)/2, cz = (bb.min.z+bb.max.z)/2, baseY = bb.min.y;
    inner.position.set(-cx, -baseY, -cz);
    const wrapper = new THREE.Group();
    wrapper.add(inner);
    const worldScale = found.getWorldScale(new THREE.Vector3());
    treeTemplate = { object: wrapper, baseScale: worldScale };
  } else {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.4, 0),
      new THREE.MeshStandardMaterial({ color:0x4a7c4e, roughness:0.85, flatShading:true })
    );
    mesh.position.y = 1.4;
    const wrapper = new THREE.Group(); wrapper.add(mesh);
    treeTemplate = { object: wrapper, baseScale: new THREE.Vector3(1,1,1) };
  }
}

/* ============================================================
   POOL D'INSTANCES — un THREE.InstancedMesh par partie du gabarit (tronc,
   feuillage...), construit une seule fois à partir de treeTemplate. Chaque
   arbre planté n'écrit plus qu'une matrice + une couleur par instance
   (aucune géométrie/matériau créé), quel que soit le nombre d'arbres.
   ============================================================ */
const TREE_CAPACITY = 8000; // large marge pour l'import en masse (trees.json) + la plantation interactive
let treePool = null; // { parts:[{mesh:InstancedMesh, baseColor:THREE.Color}], free:number[], hi:number }
const _tPos = new THREE.Vector3(), _tQuat = new THREE.Quaternion(), _tScale = new THREE.Vector3();
const _tUp = new THREE.Vector3(0,1,0);
const _tMat4 = new THREE.Matrix4();
const _tZeroMat4 = new THREE.Matrix4().makeScale(0,0,0); // instance "masquée" : réduite à rien, jamais retirée du buffer
const TREE_WARN_COLOR = new THREE.Color(0xff2d2d); // même teinte que l'ancien TREE_OVERLAP_WARN_COLOR

function buildTreePool(){
  if(!treeTemplate) findIcosphereTemplate();
  const wrapper = treeTemplate.object;
  wrapper.updateMatrixWorld(true);
  const meshesSrc = [];
  wrapper.traverse(o=>{ if(o.isMesh) meshesSrc.push(o); });
  const parts = meshesSrc.map(o=>{
    // Géométrie figée dans le repère du wrapper (position/rotation/échelle du
    // sous-noeud "baked" dans les sommets) : chaque instance n'a plus ensuite
    // qu'à appliquer sa propre matrice (position/rotation/échelle de l'arbre).
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    const srcMat = Array.isArray(o.material) ? o.material[0] : o.material;
    const baseColor = (srcMat && srcMat.color) ? srcMat.color.clone() : new THREE.Color(0xffffff);
    const mat = srcMat ? srcMat.clone() : new THREE.MeshStandardMaterial();
    // Couleur de base neutre (blanc) : la teinte RÉELLE de la partie (tronc
    // brun, feuillage vert...) est portée par instanceColor (voir
    // writeTreeInstance), multipliée par cette base — un arbre "normal" a donc
    // exactement sa couleur d'origine, et l'avertissement de chevauchement
    // (setTreesOverlapWarning) peut la remplacer par un rouge plein, comme
    // avant (identique à l'ancien m.color.setHex() par arbre).
    if(mat.color) mat.color.set(0xffffff);
    const mesh = new THREE.InstancedMesh(geo, mat, TREE_CAPACITY);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0; // relevé au fil des plantations (voir bumpTreePoolCount) : jamais plus que nécessaire à dessiner
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false; // instances dispersées sur toute la maquette : une unique sphère englobante ne "cullerait" jamais correctement
    treesGroup.add(mesh);
    return { mesh, baseColor };
  });
  const free = []; for(let i=TREE_CAPACITY-1;i>=0;i--) free.push(i);
  return { parts, free, hi:0 };
}
function ensureTreePool(){
  if(!treePool) treePool = buildTreePool();
  return treePool;
}
function bumpTreePoolCount(pool, slot){
  if(slot+1 <= pool.hi) return;
  pool.hi = slot+1;
  pool.parts.forEach(({mesh})=>{ mesh.count = pool.hi; });
}
function writeTreeInstance(pool, slot, x, y, z, rotY, scaleVec){
  _tPos.set(x, y, z);
  _tQuat.setFromAxisAngle(_tUp, rotY);
  _tMat4.compose(_tPos, _tQuat, scaleVec);
  pool.parts.forEach(({mesh, baseColor})=>{
    mesh.setMatrixAt(slot, _tMat4);
    mesh.setColorAt(slot, baseColor);
  });
}
function hideTreeInstance(pool, slot){
  pool.parts.forEach(({mesh})=> mesh.setMatrixAt(slot, _tZeroMat4));
}
function flushTreePool(pool){
  pool.parts.forEach(({mesh})=>{
    mesh.instanceMatrix.needsUpdate = true;
    if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
}
function disposeTreePool(pool){
  pool.parts.forEach(({mesh})=>{ treesGroup.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); });
}

/* ============================================================
   Boules "sphère" aux coins convexes du toit des nouveaux bâtiments
   ------------------------------------------------------------
   Gabarit cloné du premier objet nommé "sphère"/"sphere" trouvé dans la
   maquette (distinct de l'"Icosphère" utilisé pour les arbres) ; posé à
   30cm au-dessus de chaque sommet du toit dont l'angle intérieur est
   inférieur à 180° (coin convexe/saillant) — les coins rentrants (>180°,
   typiques d'une forme en L ou en U) n'en reçoivent pas. Un petit nombre par
   bâtiment : pas d'enjeu de performance, reste en Object3D non instancié.
   ============================================================ */
let roofSphereTemplate = null;
function findRoofSphereTemplate(){
  let found = null;
  siteRoot.traverse(o=>{ if(!found && /(^|[^o])sph[eè]re/i.test(o.name||'') && !/icosph/i.test(o.name||'')) found = o; });
  if(found){
    const inner = found.clone(true);
    inner.position.set(0,0,0); inner.rotation.set(0,0,0); inner.scale.set(1,1,1);
    inner.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(inner);
    const cx = (bb.min.x+bb.max.x)/2, cy=(bb.min.y+bb.max.y)/2, cz = (bb.min.z+bb.max.z)/2;
    inner.position.set(-cx, -cy, -cz); // centrée sur son propre centre
    const wrapper = new THREE.Group();
    wrapper.add(inner);
    roofSphereTemplate = wrapper;
  } else {
    // Repli si le .glb ne contient pas d'objet "sphère" (ex. mode démo)
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 16, 16),
      new THREE.MeshStandardMaterial({ color:0xd8d8d8, roughness:0.4, metalness:0.1 })
    );
    const wrapper = new THREE.Group(); wrapper.add(mesh);
    roofSphereTemplate = wrapper;
  }
}

// Appelé depuis clearSite() (index.html) : les deux gabarits sont clonés
// depuis la maquette précédemment chargée, donc invalides dès qu'une
// nouvelle maquette est chargée — ils seront recapturés au prochain besoin.
// Le pool d'instances d'arbres (géométries/matériaux figés depuis l'ANCIEN
// gabarit) est lui aussi obsolète : détruit et vidé ici, entièrement
// reconstruit par le prochain addTree()/loadSceneTreesFromJSON() une fois la
// nouvelle maquette chargée (elle-même déclenche un nouveau chargement de
// trees.json, voir index.html).
export function resetTemplates(){
  treeTemplate = null;
  roofSphereTemplate = null;
  if(treePool){ disposeTreePool(treePool); treePool = null; }
  trees = [];
  treeIdCounter = 1;
  _treesOverlapWarnedIds = new Set();
  renderTreeCount();
}

// Indices des sommets convexes (angle intérieur < 180°) d'un polygone fermé,
// indépendamment de son sens de parcours (CW/CCW).
function convexCornerIndices(pts){
  const n = pts.length;
  if(n<3) return [];
  const signedArea = (()=>{ let a=0; for(let i=0;i<n;i++){ const p1=pts[i],p2=pts[(i+1)%n]; a+=p1.x*p2.z-p2.x*p1.z; } return a; })();
  const ccw = signedArea >= 0;
  const out = [];
  for(let i=0;i<n;i++){
    const prev = pts[(i-1+n)%n], cur = pts[i], next = pts[(i+1)%n];
    const e1 = {x:cur.x-prev.x, z:cur.z-prev.z};
    const e2 = {x:next.x-cur.x, z:next.z-cur.z};
    const cross = e1.x*e2.z - e1.z*e2.x;
    const isConvex = ccw ? (cross >= 0) : (cross <= 0);
    if(isConvex) out.push(i);
  }
  return out;
}
export function buildRoofCornerSpheres(points, topY){
  if(!roofSphereTemplate) findRoofSphereTemplate();
  const group = new THREE.Group();
  const idx = convexCornerIndices(points);
  idx.forEach(i=>{
    const p = points[i];
    const s = roofSphereTemplate.clone(true);
    s.position.set(p.x, topY + 0.3, p.z);
    group.add(s);
  });
  return group;
}

export let trees = []; // { id, x, y, z, rot, scaleVariance, slot, locked }
let treeIdCounter = 1;
const treesGroup = new THREE.Group(); // ajouté à worldRoot dans initTrees() (voir commentaire là-bas)
AppState.setTreesGroup(treesGroup);
let treesVisibleFlag = true; // oeil "Arbre" — masque aussi bien les arbres plantés que les arbres de scène (trees.json)
let treePlacing = false;
AppState.setTreePlacing(treePlacing);
const btnTree = document.getElementById('btn-tree');
const drawHint = document.getElementById('draw-hint');
const drawHintText = document.getElementById('draw-hint-text');
const drawHintEnter = document.getElementById('draw-hint-enter');

export function getTreesVisible(){ return treesVisibleFlag; }
export function setTreesVisible(v){
  treesVisibleFlag = v;
  treesGroup.visible = v;
}

export function startTreeTool(){
  if(drawing) cancelDraw();
  if(drawMenuOpen) closeDrawMenu();
  if(grassPainting) stopGrassTool();
  if(labelPlacing) stopLabelTool();
  ExtGare.cancelExtensionGareIfActive();
  if(editingBuildingId) stopEditBuildingShape();
  treePlacing = true;
  AppState.setTreePlacing(treePlacing);
  btnTree.classList.add('active'); btnTree.querySelector('.tool-btn-label').textContent = 'Cliquez le polygone…';
  drawHint.classList.add('show');
  drawHintText.textContent = "Cliquez dans le polygone d'implantation pour planter un arbre · recliquez un arbre pour le retirer (Échap pour arrêter)";
  drawHintEnter.style.display = 'none';
  controls.enabled = false;
  document.getElementById('tree-mini-list').classList.add('show');
}
export function stopTreeTool(){
  treePlacing = false;
  AppState.setTreePlacing(treePlacing);
  btnTree.classList.remove('active'); btnTree.querySelector('.tool-btn-label').textContent = 'Arbre';
  drawHint.classList.remove('show');
  controls.enabled = true;
  if(treeDeleteHalo) treeDeleteHalo.visible = false;
  if(treePlantHalo) treePlantHalo.visible = false;
  if(treePreviewObj) treePreviewObj.visible = false;
  treeHoverId = null;
  renderer.domElement.style.cursor = '';
  document.getElementById('tree-mini-list').classList.remove('show');
}
btnTree.addEventListener('click', ()=> treePlacing ? stopTreeTool() : startTreeTool());
window.addEventListener('keydown', (ev)=>{
  if(!treePlacing) return;
  if(ev.key==='Escape') stopTreeTool();
});

// `opts.locked` : arbre "de scène" (trees.json) — voir le commentaire d'en-tête.
// `opts.silent` : n'appelle ni renderTreeCount() ni updateSiteStats() (utilisé
// par loadSceneTreesFromJSON pour ne le faire qu'une fois après tout un lot,
// au lieu de milliers de fois pendant la boucle).
export function addTree(pt, opts){
  opts = opts || {};
  const pool = ensureTreePool();
  if(!pool.free.length){
    if(!opts.silent && flashStatus) flashStatus(`Nombre maximal d'arbres atteint (${TREE_CAPACITY})`, true);
    return null;
  }
  const slot = pool.free.pop();
  const rot = Math.random()*Math.PI*2;
  const variance = 0.85 + Math.random()*0.3;
  _tScale.copy(treeTemplate.baseScale).multiplyScalar(variance);
  const y = pt.y||0;
  writeTreeInstance(pool, slot, pt.x, y, pt.z, rot, _tScale.clone());
  bumpTreePoolCount(pool, slot);
  flushTreePool(pool);
  const rec = { id: treeIdCounter++, slot, x:pt.x, y, z:pt.z, rot, scale:variance, locked: !!opts.locked };
  trees.push(rec);
  if(!opts.silent){ renderTreeCount(); updateSiteStats(); }
  return rec;
}
export function removeTree(id){
  const idx = trees.findIndex(x=>x.id===id);
  if(idx<0) return;
  const t = trees[idx];
  const pool = treePool;
  if(pool){ hideTreeInstance(pool, t.slot); pool.free.push(t.slot); flushTreePool(pool); }
  trees.splice(idx,1);
  _treesOverlapWarnedIds.delete(id);
  renderTreeCount();
  updateSiteStats();
}
// Ne supprime que les arbres PLANTÉS (locked:false) — les arbres "de scène"
// (trees.json) sont protégés de cette suppression en masse, comme les labels
// ADMIN verrouillés le sont de la suppression individuelle (voir labels.js).
export function clearAllTrees(){
  const pool = treePool;
  const kept = [];
  trees.forEach(t=>{
    if(t.locked){ kept.push(t); return; }
    if(pool) hideTreeInstance(pool, t.slot);
  });
  if(pool && kept.length!==trees.length) flushTreePool(pool);
  trees = kept;
  _treesOverlapWarnedIds = new Set([...trees].filter(t=>_treesOverlapWarnedIds.has(t.id)).map(t=>t.id));
  renderTreeCount();
  updateSiteStats();
}

// ------------------------------------------------------------
// Sauvegarde / chargement (JSON projet et depart.json) : encapsule la
// sérialisation minimale (position seulement — le reste est reconstruit à
// la plantation) et le remplacement intégral des arbres PLANTÉS (locked:false)
// existants. Les arbres "de scène" (trees.json) ne sont ni sérialisés dans le
// projet ni touchés par un chargement de projet — ce sont des éléments du
// décor, rechargés indépendamment depuis trees.json à chaque démarrage,
// exactement comme la géométrie de la maquette elle-même n'est jamais
// incluse dans une sauvegarde de projet.
// ------------------------------------------------------------
export function serializeTrees(){
  return trees.filter(t=>!t.locked).map(t=>({ x:t.x, z:t.z }));
}
export function loadTrees(dataTrees){
  const pool = treePool;
  const kept = [];
  trees.forEach(t=>{
    if(t.locked){ kept.push(t); return; }
    if(pool) hideTreeInstance(pool, t.slot);
  });
  if(pool) flushTreePool(pool);
  trees = kept;
  (dataTrees||[]).forEach(t=> addTree({x:t.x, y:0, z:t.z}));
}
// Nombre d'arbres PLANTÉS (locked:false) — ce que la légende/le panneau de
// l'outil affichent (les arbres de décor importés en masse depuis trees.json
// n'en font pas partie, comme le reste de la maquette).
export function plantedCount(){
  let n = 0; for(const t of trees){ if(!t.locked) n++; } return n;
}

// ------------------------------------------------------------
// Import en masse depuis trees.json — arbres "de scène" (locked:true),
// chargés au démarrage (voir tryAutoLoadTrees() dans index.html) une fois
// place_de_milan.glb ET global.glb chargés (le sol est mesuré par un rayon
// vertical sur les deux maquettes, voir groundYAt ci-dessous). Format
// attendu : [{"x":..,"z":..}, ...] — EXACTEMENT celui de serializeTrees(),
// produit par le script Blender fourni (blender/export_trees_json.py).
// ------------------------------------------------------------
const _groundRay = new THREE.Raycaster();
const _groundRayDir = new THREE.Vector3(0,-1,0);
const _groundRayOrigin = new THREE.Vector3();
// Bornes XZ (+ petite marge) de chaque cible potentielle, calculées UNE FOIS
// par lot d'import plutôt qu'à chaque arbre : un rayon dont le point tombe
// hors de la boîte d'une cible ne la raycaste même pas (pas seulement "pas
// de résultat" — l'appel de raycast lui-même, qui parcourt sinon tous les
// triangles de la cible, est évité). Pour un import en masse sur la maquette
// élargie (la grande majorité des arbres de scène), ça écarte immédiatement
// quartier/hall/gazon (propres au petit polygone d'implantation) et ne
// raycaste que globalRoot + le sol de secours — l'essentiel du gain mesuré
// (voir le commentaire de perf plus bas).
function xzBox(obj){
  const b = new THREE.Box3().setFromObject(obj);
  if(b.isEmpty()) return null;
  const m = 2; // marge (m)
  return { minX:b.min.x-m, maxX:b.max.x+m, minZ:b.min.z-m, maxZ:b.max.z+m };
}
function inXZBox(box, x, z){ return !box || (x>=box.minX && x<=box.maxX && z>=box.minZ && z<=box.maxZ); }
function groundYAt(x, z, boxes){
  _groundRayOrigin.set(x, 800, z);
  _groundRay.set(_groundRayOrigin, _groundRayDir);
  _groundRay.far = 2000;
  const targets = [];
  if(inXZBox(boxes.grass, x, z)) targets.push(...getGrassParts().map(g=>g.mesh));
  if(quartierGroup && inXZBox(boxes.quartier, x, z)) targets.push(quartierGroup);
  if(hallMesh && inXZBox(boxes.hall, x, z)) targets.push(hallMesh);
  if(globalRoot && inXZBox(boxes.global, x, z)) targets.push(globalRoot); // maquette élargie : la plupart des arbres de scène y vivent
  targets.push(ground); // secours (plan à y=0) : toujours testé en dernier
  const hits = _groundRay.intersectObjects(targets, true);
  return hits.length ? hits[0].point.y : 0;
}
// PERFORMANCE (mesuré) : un import en masse fait un rayon vertical par arbre
// contre la géométrie réelle de la maquette (~7 400 triangles pour
// global.glb) — 3000 arbres ≈ 3,3 s sans l'optimisation par boîtes XZ
// ci-dessus. C'est un coût UNIQUEMENT AU CHARGEMENT (jamais à l'image), mais
// bloquant (JS mono-thread) : voir tryAutoLoadTrees() dans index.html, qui
// l'enveloppe dans le même spinner que les autres opérations lourdes
// (bascule jour/nuit...) pour que la page n'ait pas l'air figée.
export function loadSceneTreesFromJSON(list){
  if(!Array.isArray(list) || !list.length) return 0;
  const boxes = {
    grass: null, // un mesh de gazon peint peut être ajouté/retiré après coup : pas de boîte globale fiable, toujours testé
    quartier: quartierGroup ? xzBox(quartierGroup) : null,
    hall: hallMesh ? xzBox(hallMesh) : null,
    global: globalRoot ? xzBox(globalRoot) : null,
  };
  let added = 0, capacityHit = false;
  for(const t of list){
    if(!t || !isFinite(t.x) || !isFinite(t.z)) continue;
    const rec = addTree({ x:t.x, y:groundYAt(t.x, t.z, boxes), z:t.z }, { locked:true, silent:true });
    if(rec) added++; else { capacityHit = true; break; } // pool plein : inutile de continuer à essayer
  }
  renderTreeCount();
  updateSiteStats();
  if(capacityHit) console.warn(`[Place de Milan] trees.json : capacité maximale atteinte (${TREE_CAPACITY}) — ${list.length-added} arbre(s) de scène non chargé(s).`);
  return added;
}

// ------------------------------------------------------------
// Conflit arbres / nouveau bâtiment : pendant le tracé d'une emprise au sol
// (pas un décroché en toiture, pas un volume supérieur — les arbres ne
// vivent qu'au sol), les arbres plantés qui tombent SOUS le contour en
// cours de tracé sont teintés en rouge (avertissement visuel), puis
// réellement supprimés seulement si la construction est validée. S'applique
// à TOUS les arbres, y compris "de scène" (locked) : un conflit physique
// avec un nouveau bâtiment n'a rien à voir avec la protection contre une
// suppression accidentelle au clic.
// ------------------------------------------------------------
let _treesOverlapWarnedIds = new Set();
function setTreesOverlapWarning(warnedIds){
  const pool = treePool;
  if(!pool){ _treesOverlapWarnedIds = new Set(warnedIds); return; }
  let touched = false;
  trees.forEach(t=>{
    const shouldWarn = warnedIds.has(t.id);
    const wasWarned = _treesOverlapWarnedIds.has(t.id);
    if(shouldWarn === wasWarned) return;
    pool.parts.forEach(({mesh, baseColor})=> mesh.setColorAt(t.slot, shouldWarn ? TREE_WARN_COLOR : baseColor));
    touched = true;
  });
  if(touched) pool.parts.forEach(({mesh})=>{ if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true; });
  _treesOverlapWarnedIds = new Set(warnedIds);
}
export function clearTreesOverlapWarning(){ setTreesOverlapWarning(new Set()); }
// Renvoie le contour "actuel" du tracé en cours (polygone en cours de pose,
// ou rectangle en cours de glissement), avec le point sous le curseur en
// bonus pour un avertissement bien réactif — utilisé UNIQUEMENT pour la
// prévisualisation live, jamais pour le contour final réel.
function currentDrawPreviewPolygon(livePt){
  if(getDrawMode()==='rect'){
    if(!getRectDragging() || !getRectStartPt() || !livePt) return null;
    const a=getRectStartPt(), b=livePt;
    return [{x:a.x,z:a.z},{x:b.x,z:a.z},{x:b.x,z:b.z},{x:a.x,z:b.z}];
  }
  const pts = getDrawPoints().slice();
  if(livePt) pts.push({x:livePt.x, z:livePt.z});
  return pts.length>=3 ? pts : null;
}
export function updateTreesOverlapPreview(livePt){
  // Seule une emprise AU SOL (nouveau bâtiment) peut recouvrir des arbres —
  // un décroché en toiture ou un volume supérieur est en l'air.
  if(!drawing || getVolumeDrawTargetId()!==null){ clearTreesOverlapWarning(); return; }
  const poly = currentDrawPreviewPolygon(livePt);
  updateTreesOverlapWarningForPolygon(poly);
}
// Version générique (pas seulement pour le tracé) : teinte les arbres sous
// un polygone donné — utilisée aussi pour le déplacement et la modification
// de forme (socle) d'un bâtiment déjà construit (voir startMoveBuilding /
// l'édition de forme au sol), pas seulement pour le tracé d'un nouveau.
export function updateTreesOverlapWarningForPolygon(poly){
  if(!poly || poly.length<3){ clearTreesOverlapWarning(); return; }
  const warned = new Set();
  trees.forEach(t=>{ if(pointInPolygon({x:t.x, z:t.z}, poly, 0)) warned.add(t.id); });
  setTreesOverlapWarning(warned);
}
// Supprime pour de bon les arbres tombant sous l'emprise FINALE d'un
// nouveau bâtiment, au moment où sa construction est validée (pas avant).
// S'applique aussi aux arbres "de scène" (locked) : voir le commentaire de
// setTreesOverlapWarning ci-dessus.
export function removeTreesUnderFootprint(finalPoints){
  if(!finalPoints || finalPoints.length<3) return;
  const toRemove = trees.filter(t=> pointInPolygon({x:t.x, z:t.z}, finalPoints, 0)).map(t=>t.id);
  if(!toRemove.length) return;
  toRemove.forEach(id=> removeTree(id));
}
function renderTreeCount(){
  const n = plantedCount();
  document.getElementById('tree-count').textContent = n ? `(${n})` : '';
  document.getElementById('tree-empty-note').style.display = n ? 'none' : 'block';
  document.getElementById('btn-clear-trees').style.display = n ? 'block' : 'none';
}
document.getElementById('btn-clear-trees').addEventListener('click', clearAllTrees);

// Recherche du plus proche arbre PLANTÉ (locked:false) d'un point au sol, à
// une distance maximale donnée — remplace l'ancien raycast 3D
// (`raycaster.intersectObjects(trees.map(t=>t.mesh))`), devenu inadapté
// puisque les arbres ne sont plus des Object3D individuels mais des
// instances d'un InstancedMesh partagé. Une simple comparaison de distance
// au sol est à la fois plus simple et bien moins coûteuse (un raycast 3D
// contre un InstancedMesh de plusieurs milliers d'instances, exécuté à
// chaque mouvement de souris, serait sensiblement plus cher). Les arbres
// "de scène" (locked) sont exclus : ni survolables ni cliquables pour
// suppression, comme annoncé (voir le commentaire d'en-tête du fichier).
const TREE_PICK_RADIUS = 1.8; // même rayon que le halo de suppression (voir ensureTreeDeleteHalo)
function nearestPlantedTreeAt(x, z, maxDist){
  let best = null, bestD2 = maxDist*maxDist;
  for(const t of trees){
    if(t.locked) continue;
    const dx = t.x-x, dz = t.z-z, d2 = dx*dx+dz*dz;
    if(d2 <= bestD2){ bestD2 = d2; best = t; }
  }
  return best;
}

// Enregistrement de l'écouteur différé dans wireTreeClickHandler(), appelée
// par initTrees() — voir le commentaire d'initTrees() : renderer est encore
// null tant que index.html n'a pas fini son initialisation.
function wireTreeClickHandler(){
renderer.domElement.addEventListener('click', (ev)=>{
  if(!treePlacing) return;
  const hit = treeGroundHit(eventRaycaster(ev));
  if(!hit){ flashStatus("Cliquez dans le polygone d'implantation", true); return; }

  // clic sur un arbre planté existant : on le retire (les arbres "de scène"
  // ne sont pas des cibles de suppression — voir nearestPlantedTreeAt).
  const hitTree = nearestPlantedTreeAt(hit.point.x, hit.point.z, TREE_PICK_RADIUS);
  if(hitTree){ removeTree(hitTree.id); return; }

  if(buildZone.length>=3 && !pointInPolygon({x:hit.point.x, z:hit.point.z}, buildZone)){
    flashStatus("Les arbres ne peuvent être plantés que dans le polygone d'implantation", true);
    return;
  }
  addTree(hit.point);
});
}

// Le polygone d'implantation représente la vraie surface de la place (plaza
// vide sans maillage de "quartier" dessus) : il DOIT faire partie des cibles
// de raycast, sinon un clic/survol dans une zone ouverte ne touche rien et
// retombe sur le plan de secours à Y=0, qui peut être à des dizaines de
// mètres du vrai niveau du sol une fois la maquette mise à l'échelle/translatée.
function treeGroundHit(rc){
  const groundTargets = [];
  groundTargets.push(...getGrassParts().map(g=>g.mesh));
  if(quartierGroup) quartierGroup.traverse(o=>{ if(o.isMesh) groundTargets.push(o); });
  if(hallMesh) hallMesh.traverse(o=>{ if(o.isMesh) groundTargets.push(o); });
  groundTargets.push(ground);
  return rc.intersectObjects(groundTargets, true)[0] || null;
}
// Positionne `raycaster` (partagé) depuis un évènement souris et le renvoie,
// pour un enchaînement direct avec treeGroundHit()/intersectObjects().
function eventRaycaster(ev){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster;
}
// Raycast sur les mêmes cibles que treeGroundHit (surfaces réelles de la
// maquette : gazon, quartier, hall, sol) à partir d'un événement souris —
// réutilisé par la pose de labels pour obtenir un point au sol fidèle à ce
// qui est visuellement cliqué, y compris caméra inclinée (contrairement au
// simple plan invisible utilisé par groundPointFromEvent).
export function siteGroundHitFromEvent(ev){
  const hit = treeGroundHit(eventRaycaster(ev));
  return hit ? hit.point : null;
}

// Survol en mode "Arbre" :
// - au-dessus d'un arbre PLANTÉ existant, le clic va le SUPPRIMER → halo rouge dessus.
// - au-dessus d'un emplacement plantable, le clic va CRÉER un arbre → halo
//   bleu au sol + un aperçu semi-transparent du modèle d'arbre qui suit la
//   souris, pour visualiser l'emplacement/l'échelle avant de valider.
// Les arbres "de scène" (locked) ne déclenchent ni halo ni survol : ils sont
// hors de portée de l'outil de plantation (voir nearestPlantedTreeAt).
const TREE_DELETE_COLOR = '255,64,64';
const TREE_PLANT_COLOR = NEON_BLUE_CSS;
let treeDeleteHalo = null, treePlantHalo = null, treePreviewObj = null;
let treeHoverId = null;
// NB : depthWrite:false + depthTest:false sur ces halos (via makeCircleDecal)
// veut dire qu'ils ne sont jamais bloqués par la profondeur — l'ordre visuel
// entre "objets qui dessinent par-dessus" dépend alors uniquement de
// renderOrder (dessiné en dernier = visible par-dessus). L'overlay de gazon
// peint (voir setupGrassPaintOverlay) a renderOrder=1 ; sans renderOrder
// explicite ici (défaut 0), le gazon — peint après — recouvrait le halo/
// aperçu de l'arbre-guide dès qu'on survolait une zone déjà peinte. On les
// place donc au-dessus de tout ce qui peut être peint au sol.
const TREE_GUIDE_RENDER_ORDER = 5;
function ensureTreeDeleteHalo(){
  if(treeDeleteHalo) return treeDeleteHalo;
  treeDeleteHalo = new THREE.Group();
  const disc = makeCircleDecal(1.8, TREE_DELETE_COLOR, 'fill');
  disc.position.y = 0.05;
  disc.renderOrder = TREE_GUIDE_RENDER_ORDER;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 16, 16),
    new THREE.MeshBasicMaterial({ color:0xff4040, transparent:true, opacity:0.28, depthWrite:false })
  );
  sphere.renderOrder = TREE_GUIDE_RENDER_ORDER;
  treeDeleteHalo.add(disc, sphere);
  treeDeleteHalo.visible = false;
  worldRoot.add(treeDeleteHalo);
  return treeDeleteHalo;
}
function ensureTreePlantHalo(){
  if(treePlantHalo) return treePlantHalo;
  treePlantHalo = makeCircleDecal(1.8, TREE_PLANT_COLOR, 'fill');
  treePlantHalo.position.y = 0.05;
  treePlantHalo.renderOrder = TREE_GUIDE_RENDER_ORDER;
  treePlantHalo.visible = false;
  worldRoot.add(treePlantHalo);
  return treePlantHalo;
}
function ensureTreePreviewObj(){
  if(treePreviewObj) return treePreviewObj;
  if(!treeTemplate) findIcosphereTemplate();
  treePreviewObj = treeTemplate.object.clone(true);
  treePreviewObj.scale.copy(treeTemplate.baseScale);
  treePreviewObj.traverse(o=>{
    if(o.isMesh && o.material){
      // Chaque aperçu a son propre matériau (clone) pour ne jamais teinter
      // les vrais arbres déjà plantés, qui partagent les matériaux du gabarit.
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.opacity = 0.55;
      o.material.depthWrite = false;
    }
    if(o.isMesh) o.renderOrder = TREE_GUIDE_RENDER_ORDER;
  });
  treePreviewObj.visible = false;
  worldRoot.add(treePreviewObj);
  return treePreviewObj;
}
// Enregistrement différé dans wireTreePointerMoveHandler(), appelée par
// initTrees() — même raison que wireTreeClickHandler() ci-dessus.
function wireTreePointerMoveHandler(){
renderer.domElement.addEventListener('pointermove', (ev)=>{
  if(!treePlacing) return;
  ensureTreeDeleteHalo(); ensureTreePlantHalo(); ensureTreePreviewObj();
  const groundHit = treeGroundHit(eventRaycaster(ev));
  const hitTree = groundHit ? nearestPlantedTreeAt(groundHit.point.x, groundHit.point.z, TREE_PICK_RADIUS) : null;
  if(hitTree){
    treeHoverId = hitTree.id;
    treeDeleteHalo.visible = true;
    treeDeleteHalo.position.set(hitTree.x, 0, hitTree.z);
    treePlantHalo.visible = false;
    treePreviewObj.visible = false;
    renderer.domElement.style.cursor = 'pointer';
    return;
  }
  treeHoverId = null;
  treeDeleteHalo.visible = false;
  // Emplacement plantable : halo bleu + aperçu du modèle d'arbre en 3D.
  const valid = groundHit && (buildZone.length<3 || pointInPolygon({x:groundHit.point.x, z:groundHit.point.z}, buildZone));
  if(valid){
    treePlantHalo.visible = true;
    treePlantHalo.position.set(groundHit.point.x, (groundHit.point.y||0)+0.05, groundHit.point.z);
    treePreviewObj.visible = true;
    treePreviewObj.position.set(groundHit.point.x, groundHit.point.y||0, groundHit.point.z);
    renderer.domElement.style.cursor = 'copy';
  } else {
    treePlantHalo.visible = false;
    treePreviewObj.visible = false;
    renderer.domElement.style.cursor = '';
  }
});
}
