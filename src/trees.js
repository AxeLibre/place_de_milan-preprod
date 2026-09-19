// OUTIL ARBRES — plantation contrainte au polygone d'implantation, extrait
// d'index.html.
//
// Le gabarit visuel est cloné du premier objet "Icosphère*" trouvé dans la
// maquette chargée (repli sur un icosaèdre généré si absent, ex. en mode
// démo). Un clic dans le polygone plante un arbre ; un clic sur un arbre
// existant le retire.
//
// Contient aussi les boules "sphère" posées aux coins convexes du toit des
// nouveaux bâtiments (gabarit/logique voisins de ceux des arbres), ainsi que
// siteGroundHitFromEvent — réutilisé par l'outil Label (pas encore extrait)
// pour un raycast fidèle sur les vraies surfaces de la maquette (gazon,
// quartier, hall, sol), plutôt qu'un simple plan invisible.

import * as THREE from "three";
import {
  camera, controls, renderer, worldRoot, siteRoot, buildZone, quartierGroup,
  hallMesh, ground, pointer, raycaster, drawing, drawMenuOpen, grassPainting,
  labelPlacing, editingBuildingId,
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

export let trees = [];
let treeIdCounter = 1;
const treesGroup = new THREE.Group(); // ajouté à worldRoot dans initTrees() (voir commentaire là-bas)
AppState.setTreesGroup(treesGroup);
let treesVisibleFlag = true; // oeil "Arbre"
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

/* ============================================================
   Boules "sphère" aux coins convexes du toit des nouveaux bâtiments
   ------------------------------------------------------------
   Gabarit cloné du premier objet nommé "sphère"/"sphere" trouvé dans la
   maquette (distinct de l'"Icosphère" utilisé pour les arbres) ; posé à
   30cm au-dessus de chaque sommet du toit dont l'angle intérieur est
   inférieur à 180° (coin convexe/saillant) — les coins rentrants (>180°,
   typiques d'une forme en L ou en U) n'en reçoivent pas.
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
export function resetTemplates(){
  treeTemplate = null;
  roofSphereTemplate = null;
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

export function addTree(pt){
  if(!treeTemplate) findIcosphereTemplate();
  const obj = treeTemplate.object.clone(true);
  obj.position.set(pt.x, pt.y||0, pt.z);
  obj.rotation.y = Math.random()*Math.PI*2;
  const variance = 0.85 + Math.random()*0.3;
  obj.scale.copy(treeTemplate.baseScale).multiplyScalar(variance);
  obj.traverse(o=>{
    if(o.isMesh){
      o.castShadow=true; o.receiveShadow=true;
      // clone(true) ne clone PAS les matériaux (partagés par référence avec
      // le template et donc entre tous les arbres) : on les clone ici pour
      // que chaque arbre ait son propre matériau, modifiable individuellement
      // (ex. teinte d'avertissement rouge, voir setTreesOverlapWarning) sans
      // jamais affecter les autres arbres de la maquette.
      o.material = Array.isArray(o.material) ? o.material.map(m=>m.clone()) : o.material.clone();
    }
  });
  treesGroup.add(obj);
  trees.push({ id: treeIdCounter++, mesh: obj, x:pt.x, z:pt.z });
  renderTreeCount();
  updateSiteStats();
}
export function removeTree(id){
  const t = trees.find(x=>x.id===id);
  if(!t) return;
  treesGroup.remove(t.mesh);
  trees = trees.filter(x=>x.id!==id);
  renderTreeCount();
  updateSiteStats();
}
export function clearAllTrees(){
  trees.forEach(t=> treesGroup.remove(t.mesh));
  trees = [];
  renderTreeCount();
  updateSiteStats();
}

// ------------------------------------------------------------
// Sauvegarde / chargement (JSON projet et depart.json) : encapsule la
// sérialisation minimale (position seulement — le reste est reconstruit à
// la plantation) et le remplacement intégral des arbres existants.
// ------------------------------------------------------------
export function serializeTrees(){
  return trees.map(t=>({ x:t.x, z:t.z }));
}
export function loadTrees(dataTrees){
  trees.forEach(t=> treesGroup.remove(t.mesh));
  trees = [];
  treeIdCounter = 1;
  (dataTrees||[]).forEach(t=> addTree({x:t.x, y:0, z:t.z}));
}

// ------------------------------------------------------------
// Conflit arbres / nouveau bâtiment : pendant le tracé d'une emprise au sol
// (pas un décroché en toiture, pas un volume supérieur — les arbres ne
// vivent qu'au sol), les arbres plantés qui tombent SOUS le contour en
// cours de tracé sont teintés en rouge (avertissement visuel), puis
// réellement supprimés seulement si la construction est validée.
// ------------------------------------------------------------
const TREE_OVERLAP_WARN_COLOR = 0xff2d2d;
let _treesOverlapWarnedIds = new Set();
function setTreesOverlapWarning(warnedIds){
  trees.forEach(t=>{
    const shouldWarn = warnedIds.has(t.id);
    const wasWarned = _treesOverlapWarnedIds.has(t.id);
    if(shouldWarn === wasWarned) return;
    t.mesh.traverse(o=>{
      if(!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m=>{
        if(!m || !m.color) return;
        if(shouldWarn){
          if(!m.userData._treeOverlapOrig) m.userData._treeOverlapOrig = m.color.clone();
          m.color.setHex(TREE_OVERLAP_WARN_COLOR);
        } else if(m.userData._treeOverlapOrig){
          m.color.copy(m.userData._treeOverlapOrig);
          delete m.userData._treeOverlapOrig;
        }
      });
    });
  });
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
export function removeTreesUnderFootprint(finalPoints){
  if(!finalPoints || finalPoints.length<3) return;
  const toRemove = trees.filter(t=> pointInPolygon({x:t.x, z:t.z}, finalPoints, 0)).map(t=>t.id);
  if(!toRemove.length) return;
  toRemove.forEach(id=> removeTree(id));
}
function renderTreeCount(){
  document.getElementById('tree-count').textContent = trees.length ? `(${trees.length})` : '';
  document.getElementById('tree-empty-note').style.display = trees.length ? 'none' : 'block';
  document.getElementById('btn-clear-trees').style.display = trees.length ? 'block' : 'none';
}
document.getElementById('btn-clear-trees').addEventListener('click', clearAllTrees);

// Enregistrement de l'écouteur différé dans wireTreeClickHandler(), appelée
// par initTrees() — voir le commentaire d'initTrees() : renderer est encore
// null tant que index.html n'a pas fini son initialisation.
function wireTreeClickHandler(){
renderer.domElement.addEventListener('click', (ev)=>{
  if(!treePlacing) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);

  // clic sur un arbre existant : on le retire (recursive:true, car chaque arbre
  // est maintenant un groupe tronc+feuillage, pas un mesh unique — il faut
  // remonter jusqu'au groupe racine référencé dans trees[].mesh)
  const treeHit = raycaster.intersectObjects(trees.map(t=>t.mesh), true)[0];
  if(treeHit){
    let obj = treeHit.object;
    while(obj && !trees.some(t=>t.mesh===obj)) obj = obj.parent;
    const hitTree = trees.find(t=>t.mesh===obj);
    if(hitTree){ removeTree(hitTree.id); return; }
  }

  const hit = treeGroundHit(raycaster);
  if(!hit){ flashStatus("Cliquez dans le polygone d'implantation", true); return; }
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
// Raycast sur les mêmes cibles que treeGroundHit (surfaces réelles de la
// maquette : gazon, quartier, hall, sol) à partir d'un événement souris —
// réutilisé par la pose de labels pour obtenir un point au sol fidèle à ce
// qui est visuellement cliqué, y compris caméra inclinée (contrairement au
// simple plan invisible utilisé par groundPointFromEvent).
export function siteGroundHitFromEvent(ev){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  const hit = treeGroundHit(raycaster);
  return hit ? hit.point : null;
}

// Survol en mode "Arbre" :
// - au-dessus d'un arbre existant, le clic va le SUPPRIMER → halo rouge dessus.
// - au-dessus d'un emplacement plantable, le clic va CRÉER un arbre → halo
//   bleu au sol + un aperçu semi-transparent du modèle d'arbre qui suit la
//   souris, pour visualiser l'emplacement/l'échelle avant de valider.
// Les arbres clonés partagent leurs matériaux (clone(true) ne clone pas les
// matériaux) : on ne modifie donc jamais les matériaux existants, on pose des
// halos/aperçus à part.
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
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(trees.map(t=>t.mesh), true)[0];
  if(hit){
    let obj = hit.object;
    while(obj && !trees.some(t=>t.mesh===obj)) obj = obj.parent;
    const t = trees.find(x=>x.mesh===obj);
    if(t){
      treeHoverId = t.id;
      treeDeleteHalo.visible = true;
      treeDeleteHalo.position.set(t.x, 0, t.z);
      treePlantHalo.visible = false;
      treePreviewObj.visible = false;
      renderer.domElement.style.cursor = 'pointer';
      return;
    }
  }
  treeHoverId = null;
  treeDeleteHalo.visible = false;
  // Emplacement plantable : halo bleu + aperçu du modèle d'arbre en 3D.
  const groundHit = treeGroundHit(raycaster);
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
