// ============================================================
// OUTIL EXTENSION GARE — tranches chaînables, face C fixe (collée au
// hall ou à la tranche précédente), face A déplaçable + orientable
// (plan horizontal), fusion finale par soudure des sommets proches.
// ============================================================
// Extrait d'index.html (découpage en modules ES). Dépend de l'état partagé
// (state.js) pour scene/camera/etc., et reçoit par injection (initExtensionGare)
// les quelques fonctions d'autres outils pas encore extraits (flashStatus,
// groundPointFromEvent, "stop tool X"...) puisqu'un script inline comme
// index.html ne peut pas être importé en retour par un module.

import * as THREE from "three";
import {
  scene, controls, renderer, camera, orthoCamera, planViewActive,
  hallMesh, extensionGareMesh, hallFacadeWorldNormal, siteRoot,
  drawing, drawMenuOpen, treePlacing, grassPainting, labelPlacing, editingBuildingId,
  nextId
} from './state.js';
import { convexHullXZ, dedupe } from './geometry-utils.js';
import { findAllByNameCI } from './scene-utils.js';
import { NEON_BLUE } from './config.js';

// ---- Dépendances injectées (fonctions d'autres outils, encore dans index.html) ----
let flashStatus, groundPointFromEvent, cancelDraw, closeDrawMenu,
    stopTreeTool, stopGrassTool, stopLabelTool, stopEditBuildingShape;
export function initExtensionGare(deps){
  ({ flashStatus, groundPointFromEvent, cancelDraw, closeDrawMenu,
     stopTreeTool, stopGrassTool, stopLabelTool, stopEditBuildingShape } = deps);
}

const btnExtensionGare = document.getElementById('btn-toggle-extension-gare');
const extGareLayer   = document.getElementById('ext-gare-layer');
const extGareHint     = document.getElementById('ext-gare-hint');
const extGareHintText = document.getElementById('ext-gare-hint-text');
const btnExtValider    = document.getElementById('ext-gare-valider');
const btnExtSupprDerniere = document.getElementById('ext-gare-suppr-derniere');
const btnExtAnnuler    = document.getElementById('ext-gare-annuler');

const EXT_DEPTH_DEFAULT  = 12;   // m, profondeur par défaut d'une nouvelle tranche
const EXT_HEIGHT_DEFAULT = 9;    // m, repli si la hauteur du hall n'est pas mesurable

let extToolActive   = false;
let extEditMode      = false; // true = poignées de toutes les tranches confirmées visibles (édition a posteriori)
export let extHallSlices    = [];  // tranches validées (dans l'ordre de la chaîne)
let extGareVisibleFlag = true; // oeil "Extension Gare"
let extPendingSlice  = null; // tranche en cours d'édition (déplaçable/orientable), ou null
let extDragSlice     = null; // tranche actuellement déplacée à la souris (pending OU confirmée en mode édition)
let extDragMode      = null; // 'move' | 'rotate' | null
let extModuleTemplate = undefined; // undefined = pas encore tenté, null = échec, objet = ok
const extPlusButtons = new Map(); // sliceId -> HTMLElement

// ---- Réutilisation du mesh authored "Extension_Gare" (déformation cage/FFD) ----
// Idée : plutôt que de générer une boîte procédurale (toit plat, aucun rapport
// visuel avec le hall), on prend le VRAI mesh Extension_Gare déjà modélisé
// dans le .glb (toiture, mullions, matériaux...) et on déforme ses sommets en
// coordonnées locales (u = largeur normalisée, w = profondeur normalisée)
// pour les replaquer sur le quadrilatère cible (C1, C2, A2, A1) de chaque
// tranche — une interpolation bilinéaire à 4 coins, l'équivalent d'une cage
// de déformation calculée à la volée. Ça garde la face C exactement fixe et
// la face A libre, tout en conservant l'apparence authored.
function extBuildModuleTemplate(){
  if(extModuleTemplate !== undefined) return extModuleTemplate; // déjà tenté (succès ou échec)
  if(!extensionGareMesh){ extModuleTemplate = null; return null; }
  extensionGareMesh.updateWorldMatrix(true,false);
  const parentInv = new THREE.Matrix4().copy(extensionGareMesh.matrixWorld).invert();
  const bakedMeshes = [];
  const allLocalPts = [];
  extensionGareMesh.traverse(o=>{
    if(!o.isMesh) return;
    o.updateWorldMatrix(true,false);
    const localMat = new THREE.Matrix4().multiplyMatrices(parentInv, o.matrixWorld);
    const geo = o.geometry.clone();
    geo.applyMatrix4(localMat);
    const pos = geo.attributes.position;
    for(let i=0;i<pos.count;i++) allLocalPts.push({x:pos.getX(i), y:pos.getY(i), z:pos.getZ(i)});
    bakedMeshes.push({ geo, material: o.material });
  });
  if(!bakedMeshes.length){ extModuleTemplate = null; return null; }
  let zMin=Infinity, zMax=-Infinity;
  allLocalPts.forEach(p=>{ if(p.z<zMin) zMin=p.z; if(p.z>zMax) zMax=p.z; });
  // La face C doit être proche de l'origine locale (voir consignes de nettoyage
  // Blender données à l'utilisateur) : c'est donc l'extrémité la plus proche de 0.
  const cAtMax = Math.abs(zMax) <= Math.abs(zMin);
  const zC = cAtMax ? zMax : zMin;
  const zA = cAtMax ? zMin : zMax;
  const BAND = Math.max(0.5, Math.abs(zA-zC)*0.04);
  function xRangeNear(zTarget){
    let mn=Infinity, mx=-Infinity, tol=BAND;
    for(let pass=0; pass<4 && mn===Infinity; pass++, tol*=3){
      allLocalPts.forEach(p=>{ if(Math.abs(p.z-zTarget)<=tol){ if(p.x<mn) mn=p.x; if(p.x>mx) mx=p.x; } });
    }
    return {min:mn, max:mx};
  }
  const xC = xRangeNear(zC), xA = xRangeNear(zA);
  // Le module authored n'a pas forcément la même altitude moyenne à ses deux
  // extrémités (ex : une très légère pente de toiture continue sur ~13cm
  // dans le modèle de la gare). Si on l'ignore, chaque tranche chaînée
  // repart de l'altitude "0" de sa propre face C au lieu de continuer depuis
  // l'altitude réelle de la face A précédente → un décalage vertical
  // s'accumule à chaque jointure. On mesure cet écart une fois ici
  // ("riseY") pour le reporter en cascade sur toute la chaîne (voir
  // slice.yBase dans extCreateSlice / extDeformModuleToQuad).
  function meanYNear(zTarget){
    let sum=0,n=0, tol=BAND;
    for(let pass=0; pass<4 && n===0; pass++, tol*=3){
      allLocalPts.forEach(p=>{ if(Math.abs(p.z-zTarget)<=tol){ sum+=p.y; n++; } });
    }
    return n ? sum/n : 0;
  }
  const riseY = meanYNear(zA) - meanYNear(zC);
  extModuleTemplate = { bakedMeshes, zC, zA, xC, xA, depth: Math.abs(zA-zC), riseY };
  return extModuleTemplate;
}
// Déforme le module authored (coordonnées locales) sur le quadrilatère monde
// [faceC.p1, faceC.p2, faceA.p2, faceA.p1] de la tranche. Retourne un Group
// prêt à ajouter à la scène, ou null si le template n'est pas disponible.
function extDeformModuleToQuad(slice){
  const tpl = extBuildModuleTemplate();
  if(!tpl) return null;
  const { faceC, faceA } = slice;
  const spanZ = (tpl.zA - tpl.zC) || 1;
  // Tolérances de "snap" : tout sommet suffisamment proche du bord C ou A du
  // module authored est plaqué EXACTEMENT sur la ligne cible (w=0 ou w=1,
  // idem en u) plutôt que juste "proche". Sans ça, l'interpolation linéaire
  // fait légèrement rentrer les sommets de bord vers l'intérieur de chaque
  // tranche (de manière indépendante des deux côtés de la jointure), ce qui
  // ouvre une fine fente visible entre deux tranches chaînées.
  // Tolérance de snap élargie : l'ancienne valeur (0.002 × la profondeur)
  // était trop stricte pour capter les sommets de rive de toiture/bandeau
  // (légèrement en retrait du plan C/A exact dans le mesh authored), qui
  // gardaient alors une interpolation linéaire résiduelle au lieu d'être
  // plaqués pile sur la ligne de jonction — d'où la fine marche visible
  // entre deux tranches chaînées.
  // Tolérance de snap : mesurée en mètres absolus (proportionnelle à la
  // profondeur du module), pas en fraction du profil — une fraction fixe
  // (essayée précédemment) mordait sur la zone courbe de la toiture et
  // l'aplatissait près des bords (couture "trop nette", toit simplifié).
  // Une petite marge absolue capte uniquement les tout derniers sommets de
  // rive réellement destinés à coïncider avec le plan C/A, sans toucher à
  // la courbure du toit juste avant.
  const EPS_Z = Math.max(0.1, Math.abs(spanZ)*0.018);
  const group = new THREE.Group();
  tpl.bakedMeshes.forEach(({geo, material})=>{
    const g = geo.clone();
    const pos = g.attributes.position;
    for(let i=0;i<pos.count;i++){
      const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
      let w;
      if(Math.abs(lz-tpl.zC)<=EPS_Z) w = 0;
      else if(Math.abs(lz-tpl.zA)<=EPS_Z) w = 1;
      else { w = (lz - tpl.zC) / spanZ; w = Math.max(0, Math.min(1, w)); }
      const xMinAtW = tpl.xC.min + (tpl.xA.min - tpl.xC.min)*w;
      const xMaxAtW = tpl.xC.max + (tpl.xA.max - tpl.xC.max)*w;
      const spanX = (xMaxAtW - xMinAtW) || 1;
      const EPS_X = Math.max(0.1, Math.abs(spanX)*0.018);
      let u;
      if(Math.abs(lx-xMinAtW)<=EPS_X) u = 0;
      else if(Math.abs(lx-xMaxAtW)<=EPS_X) u = 1;
      else { u = (lx - xMinAtW) / spanX; u = Math.max(-0.05, Math.min(1.05, u)); }
      const leftX  = faceC.p1.x + (faceA.p1.x-faceC.p1.x)*w, leftZ  = faceC.p1.z + (faceA.p1.z-faceC.p1.z)*w;
      const rightX = faceC.p2.x + (faceA.p2.x-faceC.p2.x)*w, rightZ = faceC.p2.z + (faceA.p2.z-faceC.p2.z)*w;
      const fx = leftX + (rightX-leftX)*u, fz = leftZ + (rightZ-leftZ)*u;
      pos.setXYZ(i, fx, ly + slice.yBase, fz);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    // IMPORTANT : on RÉUTILISE directement le matériau baked (pas de .clone()
    // ici). Les matériaux "fenêtres illuminées" (glass, glass_fenetre,
    // BATIMENTS_fenetre, glass_carre — voir makeStaticNightWindowMaterial)
    // injectent leur shader de grille de baies via `onBeforeCompile`, une
    // fonction que THREE.Material.clone()/copy() NE COPIE PAS. Un
    // .clone() ici produisait donc un matériau visuellement plat, sans
    // aucune fenêtre allumée — exactement le souci observé sur la partie
    // "glass_carre" de l'extension gare dessinée. Comme le shader calcule
    // la grille à partir de la position MONDE (pas d'UV par instance), le
    // matériau peut être partagé tel quel entre toutes les tranches sans
    // aucun effet de bord.
    const mat = material || extMaterial();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group;
}

function extMaterial(){
  let src = null;
  if(hallMesh) hallMesh.traverse(o=>{ if(!src && o.isMesh && o.material) src = o.material; });
  if(src){
    // Pas de .clone() si `src` est déjà un matériau "fenêtres illuminées"
    // (voir makeStaticNightWindowMaterial) : son shader vit dans
    // `onBeforeCompile`, une fonction que clone()/copy() ne recopie pas —
    // cloner produirait un matériau plat sans effet de nuit. Comme ce
    // matériau est partagé sans risque (shader basé sur la position monde,
    // pas d'UV par instance), on ne clone que pour appliquer `side`, et
    // uniquement quand ce n'est pas un matériau à shader partagé.
    if(src.userData && src.userData.nightWindowUniforms){
      return src;
    }
    const m = src.clone();
    m.side = THREE.DoubleSide;
    return m;
  }
  return new THREE.MeshStandardMaterial({ color:0x8fa4b3, roughness:0.6, metalness:0.1, side:THREE.DoubleSide });
}
// Le hall réel est souvent éclaté en PLUSIEURS objets dans le .glb (le loader
// glTF ajoute un suffixe hexadécimal — "Hall_Gare_5e1c11", etc. — dès que
// plusieurs pièces Blender partagent le même nom d'origine). findByNameCI ne
// renvoie qu'UN SEUL de ces morceaux (souvent un petit détail comme une
// menuiserie), ce qui donnait une façade minuscule et mal placée. On récupère
// donc ici TOUTES les pièces dont le nom commence par "Hall_Gare".
function extHallParts(){
  const parts = findAllByNameCI(siteRoot, 'Hall_Gare');
  if(parts.length) return parts;
  return hallMesh ? [hallMesh] : [];
}
function extHallHeight(){
  const parts = extHallParts();
  if(parts.length){
    const box = new THREE.Box3();
    parts.forEach(p=> box.expandByObject(p));
    const h = box.max.y - box.min.y;
    if(isFinite(h) && h>1) return h;
  }
  return EXT_HEIGHT_DEFAULT;
}
// Bord de façade (2 points au sol) le plus aligné avec une direction "vers
// l'extérieur" donnée — utilisé pour la face A du hall (première tranche)
// comme pour chaque face A déjà validée (tranches suivantes).
// "objs" peut être un objet 3D unique OU un tableau d'objets (pièces du hall
// éclatées dans le .glb — voir extHallParts()) : dans les deux cas on prend
// l'union de tous leurs sommets avant de calculer l'enveloppe.
//
// IMPORTANT : on NE PREND PAS simplement "l'arête de l'enveloppe convexe la
// mieux alignée avec la normale" — la façade réelle du hall n'est presque
// jamais un unique segment parfaitement droit dans le modèle (légers
// décrochages, sommets non parfaitement collinéaires), ce qui fait que
// l'enveloppe convexe découpe la façade en plusieurs petites arêtes. Prendre
// la "meilleure" arête isolée ne renvoyait alors qu'un minuscule tronçon de
// quelques mètres au lieu de toute la largeur du hall (~35 m). On regroupe
// donc tous les points de l'enveloppe proches du plan de façade (à une
// tolérance près le long de la normale) et on prend l'étendue complète de ce
// groupe le long de la largeur — ça couvre toute la façade même si elle
// zigzague légèrement.
function extOutwardEdgeFromObject(objs, preferredOutward){
  const list = Array.isArray(objs) ? objs : [objs];
  const pts = [];
  list.forEach(obj=>{
    obj.traverse(o=>{
      if(!o.isMesh) return;
      o.updateWorldMatrix(true,false);
      const pos = o.geometry.attributes.position;
      const v = new THREE.Vector3();
      for(let i=0;i<pos.count;i++){ v.fromBufferAttribute(pos,i).applyMatrix4(o.matrixWorld); pts.push({x:v.x,z:v.z}); }
    });
  });
  const hull = convexHullXZ(dedupe(pts));
  if(hull.length<3) return null;
  const centroid = hull.reduce((s,p)=>({x:s.x+p.x,z:s.z+p.z}),{x:0,z:0});
  centroid.x/=hull.length; centroid.z/=hull.length;
  const ref = (preferredOutward||new THREE.Vector3(0,0,1)).clone().setY(0).normalize();
  const widthDir = new THREE.Vector2(-ref.z, ref.x); // perpendiculaire, dans le plan XZ
  // projection de chaque sommet de l'enveloppe sur la normale (distance au
  // centroïde dans la direction "vers l'extérieur") et sur la largeur
  let maxN = -Infinity;
  const projN = hull.map(p=>{ const d=(p.x-centroid.x)*ref.x + (p.z-centroid.z)*ref.z; if(d>maxN) maxN=d; return d; });
  const TOL = 2.5; // m — regroupe tous les sommets à moins de 2.5 m du point le plus "avancé"
  let front = hull.filter((p,i)=> projN[i] > maxN-TOL);
  if(front.length<2) front = hull; // filet de sécurité si la tolérance est trop stricte
  let minW=Infinity, maxW=-Infinity, p1=front[0], p2=front[0];
  front.forEach(p=>{
    const w = (p.x-centroid.x)*widthDir.x + (p.z-centroid.z)*widthDir.y;
    if(w<minW){ minW=w; p1=p; }
    if(w>maxW){ maxW=w; p2=p; }
  });
  const normal = extOutwardNormalFor(p1,p2, ref);
  return { p1:{x:p1.x,z:p1.z}, p2:{x:p2.x,z:p2.z}, normal };
}
function extOutwardNormalFor(p1,p2, referenceOutward){
  let nx=(p2.z-p1.z), nz=-(p2.x-p1.x);
  const len=Math.hypot(nx,nz)||1; nx/=len; nz/=len;
  const n = new THREE.Vector3(nx,0,nz);
  if(referenceOutward && n.dot(referenceOutward)<0) n.negate();
  return n;
}
function extRemoveHandleEls(slice){
  if(slice.moveHandleEl) slice.moveHandleEl.remove();
  if(slice.rotateHandleEl) slice.rotateHandleEl.remove();
}
function extMakeHandleEl(kind){
  const el = document.createElement('div');
  el.className = 'ext-handle ' + (kind==='move' ? 'ext-handle-move' : 'ext-handle-rotate');
  el.title = kind==='move' ? 'Déplacer la face A' : 'Orienter la face A';
  el.style.display = 'none';
  extGareLayer.appendChild(el);
  return el;
}
function extCreateSlice(faceC, referenceOutward, parentSlice){
  const width = Math.hypot(faceC.p2.x-faceC.p1.x, faceC.p2.z-faceC.p1.z);
  const widthDirC = new THREE.Vector2((faceC.p2.x-faceC.p1.x)/width, (faceC.p2.z-faceC.p1.z)/width);
  const outward = extOutwardNormalFor(faceC.p1, faceC.p2, referenceOutward);
  const midC = {x:(faceC.p1.x+faceC.p2.x)/2, z:(faceC.p1.z+faceC.p2.z)/2};
  const depth = extBuildModuleTemplate()?.depth || EXT_DEPTH_DEFAULT;
  const slice = {
    id: 'ext'+nextId(),
    parentId: parentSlice ? parentSlice.id : null,
    faceC: { p1:{...faceC.p1}, p2:{...faceC.p2} },
    widthDirC,
    width,
    height: extHallHeight(),
    outwardHint: outward.clone(),
    center: { x: midC.x + outward.x*depth, z: midC.z + outward.z*depth },
    angle: Math.atan2(widthDirC.y, widthDirC.x), // direction de la largeur de A (rad)
    // Altitude cumulée de la chaîne (voir riseY dans extBuildModuleTemplate) :
    // chaque tranche reprend l'altitude de sa parente + le décalage propre au
    // module, pour que face C colle exactement (X, Y et Z) à la face A d'avant.
    yBase: parentSlice ? parentSlice.yBase + (extBuildModuleTemplate()?.riseY || 0) : 0,
    confirmed: false,
    group: new THREE.Group(),
  };
  slice.group.name = 'ExtGareTranche';
  scene.add(slice.group);
  // Poignées en overlay DOM (comme le bouton +) : toujours à taille et
  // position fixes à l'écran, jamais occultées ni sous-dimensionnées par la
  // caméra 3D — contrairement aux anciennes sphères/cônes en mesh Three.js.
  slice.moveHandleEl = extMakeHandleEl('move');
  slice.rotateHandleEl = extMakeHandleEl('rotate');
  slice.moveHandleEl.addEventListener('pointerdown', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); extDragSlice=slice; extDragMode='move'; controls.enabled=false; });
  slice.rotateHandleEl.addEventListener('pointerdown', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); extDragSlice=slice; extDragMode='rotate'; controls.enabled=false; });
  extRebuildSliceGeometry(slice);
  extUpdateHandlePositions(slice);
  return slice;
}
// Reconstruit une tranche depuis les données minimales sauvegardées en JSON
// (faceC, center, angle, width, height, yBase) — tout le reste (faceA, mesh
// déformé, poignées) est recalculé par extRebuildSliceGeometry, exactement
// comme pour une tranche créée interactivement.
function extRestoreSlice(d){
  const slice = {
    id: d.id,
    parentId: d.parentId,
    faceC: { p1:{...d.faceC.p1}, p2:{...d.faceC.p2} },
    width: d.width,
    height: d.height,
    center: { x:d.center.x, z:d.center.z },
    angle: d.angle,
    yBase: d.yBase,
    confirmed: true,
    group: new THREE.Group(),
  };
  slice.group.name = 'ExtGareTranche';
  scene.add(slice.group);
  slice.moveHandleEl = extMakeHandleEl('move');
  slice.rotateHandleEl = extMakeHandleEl('rotate');
  slice.moveHandleEl.addEventListener('pointerdown', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); extDragSlice=slice; extDragMode='move'; controls.enabled=false; });
  slice.rotateHandleEl.addEventListener('pointerdown', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); extDragSlice=slice; extDragMode='rotate'; controls.enabled=false; });
  extRebuildSliceGeometry(slice);
  extUpdateHandlePositions(slice);
  return slice;
}
function extFaceAPoints(slice){
  const dx=Math.cos(slice.angle), dz=Math.sin(slice.angle);
  const h=slice.width/2;
  return {
    p1: { x: slice.center.x - dx*h, z: slice.center.z - dz*h },
    p2: { x: slice.center.x + dx*h, z: slice.center.z + dz*h }
  };
}
function extRebuildSliceGeometry(slice){
  slice.group.clear();
  const faceA = extFaceAPoints(slice);
  slice.faceA = faceA;
  const pts = [slice.faceC.p1, slice.faceC.p2, faceA.p2, faceA.p1];
  const deformed = extDeformModuleToQuad(slice);
  if(deformed){
    slice.group.add(deformed);
  } else {
    // Repli si le mesh authored "Extension_Gare" est indisponible : simple
    // volume procédural à toit plat (moins fidèle visuellement).
    const shape = new THREE.Shape(pts.map(p=>new THREE.Vector2(p.x,-p.z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: slice.height, bevelEnabled:false, curveSegments:1 });
    geo.rotateX(-Math.PI/2);
    const mesh = new THREE.Mesh(geo, extMaterial());
    mesh.castShadow = true; mesh.receiveShadow = true;
    slice.group.add(mesh);
    const edges = new THREE.EdgesGeometry(geo, 25);
    slice.group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({color:0x0b1116, transparent:true, opacity:0.4})));
  }
  if(!slice.confirmed){
    const outlinePts = pts.map(p=>new THREE.Vector3(p.x,0.2,p.z)); outlinePts.push(outlinePts[0].clone());
    const halo = new THREE.Line(new THREE.BufferGeometry().setFromPoints(outlinePts), new THREE.LineBasicMaterial({color:NEON_BLUE, depthTest:false, transparent:true}));
    halo.renderOrder = 39;
    slice.group.add(halo);
  }
}
function extUpdateHandlePositions(slice){
  const faceA = slice.faceA;
  const visible = (slice===extPendingSlice) || (slice.confirmed && extEditMode);
  if(!visible){ slice.moveHandleEl.style.display='none'; slice.rotateHandleEl.style.display='none'; return; }
  extProjectHandleEl(slice.moveHandleEl, (faceA.p1.x+faceA.p2.x)/2, (faceA.p1.z+faceA.p2.z)/2);
  extProjectHandleEl(slice.rotateHandleEl, faceA.p2.x, faceA.p2.z);
}
// Place un marqueur DOM en projetant un point monde à l'écran (identique au
// principe déjà utilisé pour le bouton +). Utilisé pour les poignées ET
// rappelé à chaque frame (voir updateExtGarePlusButtons) pour rester
// synchronisé quand la caméra bouge.
function extProjectHandleEl(el, x, z){
  const rect = renderer.domElement.getBoundingClientRect();
  if(!rect.width||!rect.height) return;
  const activeCam = planViewActive ? orthoCamera : camera;
  const v = new THREE.Vector3(x, 0.6, z).project(activeCam);
  if(v.z>1){ el.style.display='none'; return; }
  el.style.display='block';
  el.style.left = ((v.x*0.5+0.5)*rect.width)+'px';
  el.style.top = ((1-(v.y*0.5+0.5))*rect.height)+'px';
}
// Quand on modifie la face A d'une tranche déjà confirmée (via ses poignées
// en mode édition), toutes les tranches suivantes de la chaîne doivent
// recoller leur face C dessus, sinon la chaîne se déchire à partir de là.
function extPropagateChainFrom(index){
  for(let j=index; j<extHallSlices.length; j++){
    const prev = extHallSlices[j-1];
    const cur = extHallSlices[j];
    cur.faceC = { p1:{x:prev.faceA.p1.x, z:prev.faceA.p1.z}, p2:{x:prev.faceA.p2.x, z:prev.faceA.p2.z} };
    cur.yBase = prev.yBase + (extBuildModuleTemplate()?.riseY || 0);
    extRebuildSliceGeometry(cur);
    extUpdateHandlePositions(cur);
  }
  // Si une NOUVELLE tranche est en cours de création (pas encore validée)
  // au bout de la chaîne qu'on vient de mettre à jour, elle doit suivre elle
  // aussi — sinon elle reste "orpheline" tant qu'on ne la fait pas glisser
  // soi-même après coup.
  const tip = extHallSlices[extHallSlices.length-1];
  if(extPendingSlice && tip && extPendingSlice.parentId===tip.id){
    extPendingSlice.faceC = { p1:{x:tip.faceA.p1.x, z:tip.faceA.p1.z}, p2:{x:tip.faceA.p2.x, z:tip.faceA.p2.z} };
    extPendingSlice.yBase = tip.yBase + (extBuildModuleTemplate()?.riseY || 0);
    extRebuildSliceGeometry(extPendingSlice);
    extUpdateHandlePositions(extPendingSlice);
  }
}


/* ---- démarrage / chaînage / validation ---------------------------- */
function startExtensionGareTool(){
  if(drawing) cancelDraw();
  if(drawMenuOpen) closeDrawMenu();
  if(treePlacing) stopTreeTool();
  if(grassPainting) stopGrassTool();
  if(labelPlacing) stopLabelTool();
  if(editingBuildingId) stopEditBuildingShape();
  const hallParts = extHallParts();
  if(!hallParts.length){ flashStatus("Hall de gare introuvable dans la maquette chargée", true); return; }
  extToolActive = true;
  btnExtensionGare.classList.add('active');
  const edge = extOutwardEdgeFromObject(hallParts, hallFacadeWorldNormal);
  if(!edge){ flashStatus("Impossible de déterminer la façade du hall", true); extToolActive=false; return; }
  // Léger recouvrement (quelques cm) vers l'intérieur du hall : la façade
  // détectée par enveloppe convexe est une approximation qui peut être
  // décalée de quelques centimètres du vrai mesh du hall — sans marge, ça
  // laissait une fine fente visible à la toute première jointure (hall →
  // tranche 1). En reculant légèrement la face C dans le volume du hall,
  // les deux se chevauchent au lieu de laisser un interstice.
  const HALL_OVERLAP = 0.15; // m
  const n = edge.normal;
  edge.p1 = { x: edge.p1.x - n.x*HALL_OVERLAP, z: edge.p1.z - n.z*HALL_OVERLAP };
  edge.p2 = { x: edge.p2.x - n.x*HALL_OVERLAP, z: edge.p2.z - n.z*HALL_OVERLAP };
  extPendingSlice = extCreateSlice(edge, hallFacadeWorldNormal || edge.normal, null);
  extRefreshBar();
}
// Bouton toolbar "Ajouter Extension Gare" — cycle à 3 états :
//  1) rien construit               -> démarre la création de la 1ère tranche
//  2) construit, affiché en édition -> cache l'extension (sans rien supprimer)
//  3) construit, caché              -> réaffiche en mode édition (poignées + (+))
export function toggleExtensionGareTool(){
  if(extPendingSlice) return; // création en cours : on passe par Valider/Annuler
  if(!extHallSlices.length){ startExtensionGareTool(); return; }
  if(extEditMode) extHideExtension(); else extShowExtensionForEditing();
}
// "Terminer" : cache uniquement les guides d'édition (poignées, halos, bouton
// +), PAS l'extension elle-même — son groupe reste visible pour continuer à
// s'afficher sur la maquette. Utiliser l'oeil dédié dans la barre d'outils
// pour masquer/afficher l'extension construite.
function extHideExtension(){
  extEditMode = false;
  extToolActive = false;
  extHallSlices.forEach(s=> extUpdateHandlePositions(s));
  extPlusButtons.forEach(btn=> btn.remove());
  extPlusButtons.clear();
  btnExtensionGare.classList.remove('active');
  extRefreshBar();
}
function extShowExtensionForEditing(){
  if(drawing) cancelDraw();
  if(drawMenuOpen) closeDrawMenu();
  if(treePlacing) stopTreeTool();
  if(grassPainting) stopGrassTool();
  if(labelPlacing) stopLabelTool();
  if(editingBuildingId) stopEditBuildingShape();
  extEditMode = true;
  extToolActive = true;
  btnExtensionGare.classList.add('active');
  extHallSlices.forEach(s=>{ s.group.visible = true; extUpdateHandlePositions(s); });
  const last = extHallSlices[extHallSlices.length-1];
  if(last) extMakePlusButton(last);
  extRefreshBar();
}
function extAddChainedSlice(parentSlice){
  extToolActive = true;
  btnExtensionGare.classList.add('active');
  const faceC = { p1:{x:parentSlice.faceA.p1.x, z:parentSlice.faceA.p1.z}, p2:{x:parentSlice.faceA.p2.x, z:parentSlice.faceA.p2.z} };
  // IMPORTANT : on utilise la direction ACTUELLE de la tranche parente
  // (centre de sa face A moins centre de sa face C), pas son "outwardHint"
  // figé au moment de sa propre création. Si le parent a depuis été pivoté
  // significativement, l'ancien indice figé pouvait être quasi perpendiculaire
  // à sa nouvelle orientation réelle, faisant partir la nouvelle tranche du
  // mauvais côté (effet "détaché") avant que l'utilisateur ne la repositionne.
  const pMidC = {x:(parentSlice.faceC.p1.x+parentSlice.faceC.p2.x)/2, z:(parentSlice.faceC.p1.z+parentSlice.faceC.p2.z)/2};
  const pMidA = {x:(parentSlice.faceA.p1.x+parentSlice.faceA.p2.x)/2, z:(parentSlice.faceA.p1.z+parentSlice.faceA.p2.z)/2};
  const liveDir = new THREE.Vector3(pMidA.x-pMidC.x, 0, pMidA.z-pMidC.z);
  if(liveDir.lengthSq() < 1e-6) liveDir.copy(parentSlice.outwardHint); // filet de sécurité (parent quasi nul)
  else liveDir.normalize();
  extPendingSlice = extCreateSlice(faceC, liveDir, parentSlice);
  extRemovePlusButton(parentSlice.id);
  extRefreshBar();
}
// Met à jour le texte + la visibilité des boutons de la barre selon l'état
// courant (création d'une nouvelle tranche VS édition des tranches déjà
// posées VS rien à afficher).
function extRefreshBar(){
  const creating = !!extPendingSlice;
  const editing = !creating && extEditMode && extHallSlices.length>0;
  if(!creating && !editing){ extGareHint.classList.remove('show'); return; }
  extGareHint.classList.add('show');
  extGareHintText.textContent = creating
    ? "Fais glisser la sphère orange pour déplacer la face A, la poignée bleue pour l'orienter."
    : "Glisse les poignées pour ajuster une tranche, clique le (+) ou \"Ajouter nouvelle tranche\" pour en ajouter une.";
  btnExtValider.style.display = (creating || editing) ? '' : 'none';
  btnExtValider.textContent = creating ? 'Valider la tranche' : 'Ajouter nouvelle tranche';
  btnExtSupprDerniere.style.display = extHallSlices.length>0 ? '' : 'none';
  btnExtAnnuler.textContent = creating ? 'Annuler' : 'Terminer';
}
function extConfirmPendingSlice(){
  if(!extPendingSlice) return;
  const slice = extPendingSlice;
  slice.confirmed = true;
  extPendingSlice = null;
  extRebuildSliceGeometry(slice);
  slice.group.visible = extGareVisibleFlag;
  extHallSlices.push(slice);
  extEditMode = true;
  extToolActive = true;
  btnExtensionGare.classList.add('active');
  extMakePlusButton(slice);
  extUpdateHandlePositions(slice);
  extRefreshBar();
}
function extCancelPendingSlice(){
  if(!extPendingSlice) return;
  const slice = extPendingSlice;
  scene.remove(slice.group);
  extRemoveHandleEls(slice);
  extPendingSlice = null;
  if(slice.parentId && extHallSlices.length){
    const parent = extHallSlices.find(s=>s.id===slice.parentId);
    if(parent) extMakePlusButton(parent);
    extEditMode = true;
    extRefreshBar();
  } else {
    extExitToolFully();
  }
}
// Supprime la DERNIÈRE tranche confirmée de la chaîne (utile pour revenir en
// arrière sans tout recommencer). Si une nouvelle tranche est en cours de
// création à partir de celle qu'on supprime, elle est annulée avec.
function extDeleteLastSlice(){
  if(!extHallSlices.length) return;
  const last = extHallSlices[extHallSlices.length-1];
  if(extPendingSlice && extPendingSlice.parentId===last.id){
    scene.remove(extPendingSlice.group);
    extRemoveHandleEls(extPendingSlice);
    extPendingSlice = null;
  }
  extHallSlices.pop();
  extRemovePlusButton(last.id);
  scene.remove(last.group);
  extRemoveHandleEls(last);
  if(!extHallSlices.length && !extPendingSlice){ extExitToolFully(); return; }
  const newLast = extHallSlices[extHallSlices.length-1];
  if(newLast && !extPendingSlice) extMakePlusButton(newLast);
  if(!extPendingSlice) extEditMode = true;
  extRefreshBar();
}
// Suppression COMPLÈTE (uniquement quand on annule la toute première tranche
// jamais validée — dans tous les autres cas on cache au lieu de supprimer).
function extExitToolFully(){
  extToolActive = false;
  extEditMode = false;
  btnExtensionGare.classList.remove('active');
  if(extPendingSlice){ scene.remove(extPendingSlice.group); extRemoveHandleEls(extPendingSlice); extPendingSlice=null; }
  extHallSlices.forEach(s=>{ scene.remove(s.group); extRemoveHandleEls(s); });
  extHallSlices = [];
  extPlusButtons.forEach(btn=>btn.remove());
  extPlusButtons.clear();
  extGareHint.classList.remove('show');
}
function extMakePlusButton(slice){
  extRemovePlusButton(slice.id);
  const btn = document.createElement('div');
  btn.className = 'ext-plus-btn';
  btn.textContent = '+';
  btn.title = 'Ajouter une nouvelle tranche de hall';
  btn.addEventListener('click', ()=> extAddChainedSlice(slice));
  extGareLayer.appendChild(btn);
  extPlusButtons.set(slice.id, btn);
}
function extRemovePlusButton(sliceId){
  const btn = extPlusButtons.get(sliceId);
  if(btn){ btn.remove(); extPlusButtons.delete(sliceId); }
}
export function updateExtGarePlusButtons(){
  // Poignées : suivent la caméra à chaque frame (pending + toutes les
  // tranches confirmées si le mode édition est actif).
  if(extPendingSlice) extUpdateHandlePositions(extPendingSlice);
  if(extEditMode) extHallSlices.forEach(s=> extUpdateHandlePositions(s));
  // Boutons (+)
  if(!extPlusButtons.size) return;
  if(!extEditMode && !extPendingSlice){ extPlusButtons.forEach(btn=> btn.style.display='none'); return; }
  const rect = renderer.domElement.getBoundingClientRect();
  if(!rect.width||!rect.height) return;
  const activeCam = planViewActive ? orthoCamera : camera;
  const v = new THREE.Vector3();
  extHallSlices.forEach(slice=>{
    const btn = extPlusButtons.get(slice.id);
    if(!btn) return;
    const cx=(slice.faceA.p1.x+slice.faceA.p2.x)/2, cz=(slice.faceA.p1.z+slice.faceA.p2.z)/2;
    v.set(cx, slice.height+1.6, cz).project(activeCam);
    const behind = v.z>1;
    btn.style.display = behind ? 'none' : 'flex';
    btn.style.left = ((v.x*0.5+0.5)*rect.width)+'px';
    btn.style.top = ((1-(v.y*0.5+0.5))*rect.height)+'px';
  });
}


/* ---- interactions souris : déplacer / orienter la face A (tranche en
   cours de création OU n'importe quelle tranche confirmée en mode édition).
   Le pointerdown est posé directement sur chaque poignée DOM (voir
   extCreateSlice) — plus besoin de raycaster sur des meshes 3D, ce qui
   supprime tout souci de visibilité/angle de caméra. On écoute le
   déplacement sur window (pas juste le canvas) pour ne pas perdre le drag
   si le curseur sort momentanément de la zone. */
window.addEventListener('pointermove', (ev)=>{
  if(!extDragMode || !extDragSlice) return;
  const pt = groundPointFromEvent(ev);
  if(!pt) return;
  if(extDragMode==='move'){
    extDragSlice.center = { x: pt.x, z: pt.z };
  } else {
    const dx = pt.x - extDragSlice.center.x, dz = pt.z - extDragSlice.center.z;
    if(Math.hypot(dx,dz) > 0.3) extDragSlice.angle = Math.atan2(dz,dx);
  }
  extRebuildSliceGeometry(extDragSlice);
  extUpdateHandlePositions(extDragSlice);
  if(extDragSlice.confirmed){
    const idx = extHallSlices.indexOf(extDragSlice);
    if(idx>=0) extPropagateChainFrom(idx+1);
  }
});
window.addEventListener('pointerup', ()=>{
  if(!extDragMode) return;
  extDragMode = null;
  extDragSlice = null;
  controls.enabled = true;
});
btnExtValider.addEventListener('click', ()=>{
  if(extPendingSlice) extConfirmPendingSlice();
  else if(extHallSlices.length) extAddChainedSlice(extHallSlices[extHallSlices.length-1]);
});
btnExtAnnuler.addEventListener('click', ()=>{
  if(extPendingSlice) extCancelPendingSlice(); else extHideExtension();
});
btnExtSupprDerniere.addEventListener('click', extDeleteLastSlice);

// ============================================================
// API publique complémentaire — remplace les accès directs qu'index.html
// faisait auparavant aux variables internes ci-dessus (impossible une fois
// ce module isolé : un import ES est en lecture seule pour l'importeur).
// ============================================================

// Utilisé par les nombreuses fonctions "démarrer l'outil X" (dessin, arbre,
// gazon, label, édition de bâtiment...) pour annuler proprement une tranche
// en cours / repasser en mode caché avant de démarrer un autre outil.
export function cancelExtensionGareIfActive(){
  if(extPendingSlice) extCancelPendingSlice();
  else if(extEditMode) extHideExtension();
}

// Bascule "œil" dédiée (barre d'outils gauche).
export function getExtGareVisible(){ return extGareVisibleFlag; }
export function setExtGareVisible(v){
  extGareVisibleFlag = v;
  extHallSlices.forEach(s=> s.group.visible = v);
}

// Chargement d'un projet JSON : remplace tout l'état actuel de l'extension
// gare par celui contenu dans `dataArray` (peut être vide/absent).
export function loadExtensionGare(dataArray){
  extExitToolFully();
  if(dataArray && dataArray.length){
    dataArray.forEach(d=> extHallSlices.push(extRestoreSlice(d)));
    extToolActive = false; extEditMode = false;
    btnExtensionGare.classList.remove('active');
  }
}

// Sérialisation pour la sauvegarde JSON.
export function serializeExtensionGare(){
  return extHallSlices.map(s=>({
    id:s.id, parentId:s.parentId, faceC:s.faceC, center:s.center,
    angle:s.angle, width:s.width, height:s.height, yBase:s.yBase
  }));
}
