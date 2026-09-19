// OUTIL GAZON — peinture au sol sur le polygone d'implantation, extrait
// d'index.html.
//
// Pas besoin de subdiviser le mesh Blender en petites faces : on peint dans
// une texture (canvas 2D) posée en surcouche sur le polygone, à l'endroit où
// le rayon de la souris touche le mesh — le point d'impact donne directement
// ses coordonnées UV (Raycaster les fournit automatiquement si le mesh a un
// attribut UV, ce qui est le cas ici). La résolution du pinceau est donc
// limitée par la résolution de la texture, pas par le nombre de faces.

import * as THREE from "three";
import {
  camera, controls, renderer, worldRoot, siteRoot, buildings, treesGroup,
  drawing, drawMenuOpen, editingBuildingId, treePlacing, labelPlacing,
  pointer, raycaster,
} from './state.js';
import * as AppState from './state.js';
import * as ExtGare from './extension-gare.js';
import * as Trees from './trees.js';

// Dépendances pas encore extraites (outil de tracé, outil Label, édition de
// bâtiment, stats du panneau...), injectées une fois par initGrass().
let cancelDraw, closeDrawMenu, stopLabelTool, stopEditBuildingShape,
    updateSiteStats, makeCircleDecal, groundPointFromEvent;

export function initGrass(deps){
  ({
    cancelDraw, closeDrawMenu, stopLabelTool, stopEditBuildingShape,
    updateSiteStats, makeCircleDecal, groundPointFromEvent,
  } = deps);
  wireGrassPointerMoveHandler();
  wireGrassPointerDownHandler();
}

export let grassParts = []; // [{mesh, overlayMesh, canvas, ctx, texture, worldSpan, worldArea}]
let grassVisibleFlag = true; // oeil "Gazon"
let grassBrushRadius = 12; // px, sur un canvas de 1024 — "moyen" par défaut (réduit à nouveau : la tache peinte réelle restait bien plus grande que ce que son cercle-guide au sol laissait penser)

export function getGrassVisible(){ return grassVisibleFlag; }
export function setGrassVisible(v){
  grassVisibleFlag = v;
  grassParts.forEach(p=> p.overlayMesh.visible = v);
}

// Aire exacte (m², repère monde) d'une géométrie de mesh : somme des aires de
// triangles après application de sa matrice monde — fiable quelle que soit
// l'échelle/rotation héritée de la chaîne de parents, contrairement à une
// simple bounding box.
function computeMeshWorldArea(mesh){
  const geo = mesh.geometry;
  const pos = geo.attributes && geo.attributes.position;
  if(!pos) return 0;
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const idx = geo.index;
  const triCount = idx ? Math.floor(idx.count/3) : Math.floor(pos.count/3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  for(let i=0;i<triCount;i++){
    let ia, ib, ic;
    if(idx){ ia=idx.getX(i*3); ib=idx.getX(i*3+1); ic=idx.getX(i*3+2); }
    else { ia=i*3; ib=i*3+1; ic=i*3+2; }
    a.fromBufferAttribute(pos, ia).applyMatrix4(m);
    b.fromBufferAttribute(pos, ib).applyMatrix4(m);
    c.fromBufferAttribute(pos, ic).applyMatrix4(m);
    area += new THREE.Triangle(a,b,c).getArea();
  }
  return area;
}
export function setupGrassPaintOverlay(parts){
  grassParts = [];
  parts.forEach(mesh=>{
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); // computeGrassAreaM2() relit ce canvas régulièrement via getImageData
    ctx.clearRect(0,0,size,size); // rien de peint au départ : transparent partout
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshStandardMaterial({
      map: texture, transparent:true, roughness:0.9, metalness:0,
      depthWrite:false, polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1
    });
    // Même géométrie que la pièce du polygone (mêmes UV) posée juste au-dessus,
    // en enfant direct : hérite automatiquement de sa position/échelle/rotation.
    const overlayMesh = new THREE.Mesh(mesh.geometry, mat);
    overlayMesh.visible = grassVisibleFlag;
    overlayMesh.position.y = 0.02;
    overlayMesh.renderOrder = 1;
    mesh.add(overlayMesh);
    // Étendue RÉELLE (en unités monde) couverte par ce fragment de sol — le
    // canvas 1024×1024 de peinture est mappé en UV sur CETTE géométrie
    // précise, pas sur le polygone d'implantation entier : utiliser l'emprise
    // du polygone entier pour convertir px→mètres (ancien calcul) donnait un
    // facteur d'échelle totalement faux dès que ce fragment était plus petit
    // que le polygone complet — d'où l'écart énorme observé entre le cercle
    // guide et la tache réellement peinte.
    // BUG CORRIGÉ : ce calcul utilisait mesh.geometry.boundingBox, c'est-à-dire
    // l'étendue en espace LOCAL de la géométrie — en ignorant complètement
    // l'échelle propre du mesh et de ses parents jusqu'à worldRoot (le repère
    // dans lequel vit le cercle-guide grassCursorDecal). Si ce fragment de sol
    // est mis à l'échelle quelque part dans sa chaîne de parenté (import GLB,
    // groupe "quartier"…), l'étendue réelle au sol pouvait être plusieurs fois
    // plus grande que ce que la géométrie locale laissait croire — d'où le
    // cercle-guide bien plus petit que la tache réellement peinte. On calcule
    // maintenant la bounding box dans le repère de worldRoot (même repère que
    // le décalque), en combinant les matrices monde du mesh et de worldRoot.
    mesh.updateWorldMatrix(true, false);
    worldRoot.updateWorldMatrix(true, false);
    const relMatrix = new THREE.Matrix4().copy(worldRoot.matrixWorld).invert().multiply(mesh.matrixWorld);
    if(!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bbRel = mesh.geometry.boundingBox.clone().applyMatrix4(relMatrix);
    const worldSpan = (Math.abs(bbRel.max.x-bbRel.min.x) + Math.abs(bbRel.max.z-bbRel.min.z)) / 2;
    // Surface RÉELLE (m², dans le repère monde) de ce fragment de sol — calculée
    // en sommant l'aire de chaque triangle de la géométrie transformée par sa
    // matrice monde. Contrairement à `worldSpan` (une moyenne largeur/hauteur
    // de la bounding box, pratique pour convertir un RAYON de pinceau mais
    // fausse dès que le fragment n'est pas carré ou que sa silhouette n'occupe
    // pas tout son rectangle englobant), ceci donne l'aire exacte, utilisée
    // uniquement pour le calcul du % d'espaces verts (voir computeGrassAreaM2).
    const worldArea = computeMeshWorldArea(mesh);
    grassParts.push({ mesh, overlayMesh, canvas, ctx, texture, worldSpan: worldSpan || 60, worldArea: worldArea || 0 });
  });
}

// Surface peinte en gazon (m²) : lecture du canal alpha de chaque canvas de
// peinture (voir setupGrassPaintOverlay) — un pixel avec alpha>0 compte comme
// peint, converti en m² via le ratio worldSpan/1024 déjà utilisé ailleurs
// (grassBrushWorldRadius) pour passer du repère pixel au repère monde.
export function computeGrassAreaM2(){
  let total = 0;
  grassParts.forEach(part=>{
    let data;
    try{ data = part.ctx.getImageData(0,0,part.canvas.width,part.canvas.height).data; }
    catch(e){ return; } // canvas potentiellement "tainted" — on ignore silencieusement
    let painted = 0;
    const totalPx = part.canvas.width * part.canvas.height;
    for(let i=3;i<data.length;i+=4){ if(data[i]>10) painted++; }
    // Fraction du canvas peinte × aire monde EXACTE du fragment (voir
    // computeMeshWorldArea) — ne dépend d'aucune hypothèse de forme carrée ou
    // de bounding box, donc fiable même pour un fragment de sol irrégulier.
    total += (painted/totalPx) * (part.worldArea||0);
  });
  return total;
}

// ------------------------------------------------------------
// Sauvegarde / chargement (JSON projet) : une entrée par fragment de sol
// (dans le même ordre que grassParts, reconstitué au chargement du .glb,
// donc déjà présent) — sérialisée en dataURL PNG.
// ------------------------------------------------------------
export function serializeGrass(){
  return grassParts.map(p=> p.canvas.toDataURL('image/png'));
}
export function loadGrass(dataArray){
  if(!dataArray || !dataArray.length || !grassParts.length) return;
  dataArray.forEach((dataUrl, i)=>{
    const part = grassParts[i];
    if(!part || !dataUrl) return;
    const img = new Image();
    img.onload = ()=>{
      part.ctx.clearRect(0,0,part.canvas.width,part.canvas.height);
      part.ctx.drawImage(img, 0, 0, part.canvas.width, part.canvas.height);
      part.texture.needsUpdate = true;
      updateSiteStats();
    };
    img.src = dataUrl;
  });
}

let grassPainting = false;
AppState.setGrassPainting(grassPainting);
let grassPointerActive = false;
const btnGrass = document.getElementById('btn-paint-grass');
const grassBrushPopout = document.getElementById('grass-brush-popout');
const drawHint = document.getElementById('draw-hint');
const drawHintText = document.getElementById('draw-hint-text');
const drawHintEnter = document.getElementById('draw-hint-enter');
function positionGrassBrushPopout(){
  const r = btnGrass.getBoundingClientRect();
  grassBrushPopout.style.left = (r.right + 8) + 'px';
  grassBrushPopout.style.top = r.top + 'px';
}
window.addEventListener('resize', ()=>{ if(grassPainting) positionGrassBrushPopout(); });

// Repère circulaire au sol pour le pinceau de gazon : à l'inverse du guide de
// tracé, il est plein sur le bord intérieur (le contour du pinceau) et
// transparent en allant vers le centre.
const GRASS_CURSOR_COLOR = '124,220,110';
let grassCursorDecal = null;
function ensureGrassCursorDecal(){
  if(grassCursorDecal) return grassCursorDecal;
  grassCursorDecal = makeCircleDecal(1, GRASS_CURSOR_COLOR, 'ring', 0.85);
  grassCursorDecal.position.y = 0.22;
  grassCursorDecal.visible = false;
  worldRoot.add(grassCursorDecal);
  return grassCursorDecal;
}
// Appelée depuis la boucle de rendu (index.html) : fait "pulser" l'opacité du
// cercle-guide pendant qu'il est visible — vit ici parce que grassCursorDecal
// est un état privé de ce module.
export function pulseGrassCursor(){
  if(!grassCursorDecal || !grassCursorDecal.visible) return;
  const t = performance.now()/1000;
  grassCursorDecal.material.opacity = 0.75 + Math.sin(t*4)*0.15;
}
// Conversion rayon pinceau (px sur canvas 1024) -> unités monde, à partir de
// l'étendue RÉELLE du fragment de sol effectivement survolé (voir
// setupGrassPaintOverlay) — et non plus du polygone d'implantation entier.
function grassBrushWorldRadius(part){
  const span = part ? part.worldSpan : 60;
  return grassBrushRadius/1024 * span;
}
function grassPartUnderCursor(ev){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(grassParts.map(g=>g.mesh), true)[0];
  if(!hit) return null;
  return grassParts.find(g=>g.mesh===hit.object) || null;
}
function updateGrassCursor(ev){
  ensureGrassCursorDecal();
  const pt = groundPointFromEvent(ev);
  if(!pt){ grassCursorDecal.visible = false; return; }
  grassCursorDecal.visible = true;
  grassCursorDecal.position.set(pt.x, 0.22, pt.z);
  const part = grassPartUnderCursor(ev);
  const r = Math.max(0.4, grassBrushWorldRadius(part));
  grassCursorDecal.scale.setScalar(r);
}
// Câblage différé (voir initGrass()) : au moment où ce module est évalué,
// renderer est encore null (imports statiques évalués avant le corps du
// script d'index.html).
function wireGrassPointerMoveHandler(){
renderer.domElement.addEventListener('pointermove', (ev)=>{
  if(!grassPainting) return;
  updateGrassCursor(ev);
});
}

export function startGrassTool(){
  if(drawing) cancelDraw();
  if(drawMenuOpen) closeDrawMenu();
  if(treePlacing) Trees.stopTreeTool();
  if(labelPlacing) stopLabelTool();
  ExtGare.cancelExtensionGareIfActive();
  if(editingBuildingId) stopEditBuildingShape();
  grassPainting = true;
  AppState.setGrassPainting(grassPainting);
  btnGrass.classList.add('active'); btnGrass.querySelector('.tool-btn-label').textContent = 'Glissez pour peindre…';
  drawHint.classList.add('show');
  drawHintText.textContent = "Glissez sur la place pour peindre du gazon · clic droit pour effacer (Échap pour arrêter)";
  drawHintEnter.style.display = 'none';
  ensureGrassCursorDecal();
  updateBrushRowState();
  positionGrassBrushPopout();
  grassBrushPopout.classList.add('show');
}
export function stopGrassTool(){
  grassPainting = false;
  AppState.setGrassPainting(grassPainting);
  btnGrass.classList.remove('active'); btnGrass.querySelector('.tool-btn-label').textContent = 'Gazon';
  drawHint.classList.remove('show');
  if(grassCursorDecal) grassCursorDecal.visible = false;
  updateBrushRowState();
  grassBrushPopout.classList.remove('show');
}
btnGrass.addEventListener('click', ()=> grassPainting ? stopGrassTool() : startGrassTool());
window.addEventListener('keydown', (ev)=>{ if(grassPainting && ev.key==='Escape') stopGrassTool(); });

function paintGrassAt(ev, erase){
  if(!grassParts.length) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(grassParts.map(g=>g.mesh), true)[0];
  if(!hit || !hit.uv) return;
  const part = grassParts.find(g=>g.mesh===hit.object) || grassParts[0];
  const px = hit.uv.x * part.canvas.width;
  const py = (1-hit.uv.y) * part.canvas.height;
  part.ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  // Dégradé resserré : plein jusqu'à 70% du rayon puis chute rapide sur les
  // 30% restants — un dégradé qui s'étalait doucement dès le centre (ancien
  // 2-stops) donnait l'illusion d'une tache bien plus large que le rayon
  // réellement réglé, car sa moitié externe restait visible à l'œil malgré
  // une opacité déjà faible.
  const grad = part.ctx.createRadialGradient(px,py,0, px,py,grassBrushRadius);
  if(erase){
    grad.addColorStop(0,'rgba(0,0,0,1)');
    grad.addColorStop(0.7,'rgba(0,0,0,1)');
    grad.addColorStop(1,'rgba(0,0,0,0)');
  } else {
    grad.addColorStop(0,'rgba(94,168,84,0.95)');
    grad.addColorStop(0.7,'rgba(94,168,84,0.95)');
    grad.addColorStop(1,'rgba(94,168,84,0)');
  }
  part.ctx.fillStyle = grad;
  part.ctx.beginPath();
  part.ctx.arc(px,py,grassBrushRadius,0,Math.PI*2);
  part.ctx.fill();
  part.texture.needsUpdate = true;
}

// Détection large "clic sur la maquette" (peu importe l'élément précis :
// gazon, quartier, hall, bâtiments, arbres…) — utilisée pour décider si
// l'orbite caméra doit être bloquée pendant la peinture de gazon. Distincte
// de grassPartUnderCursor (qui ne teste QUE les fragments de sol peignables,
// pour savoir où peindre) : un clic sur un bâtiment ou un arbre, par exemple,
// doit lui aussi bloquer la caméra puisqu'il tombe bien "sur la maquette",
// même s'il n'y a rien à y peindre.
function modelHitTargets(){
  const targets = [siteRoot];
  buildings.forEach(b=>{ if(b.group) targets.push(b.group); });
  if(treesGroup) targets.push(treesGroup);
  return targets;
}
function isClickOnModel(ev){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(modelHitTargets(), true).length>0;
}
// Câblage différé (voir initGrass()) — même raison que wireGrassPointerMoveHandler().
function wireGrassPointerDownHandler(){
renderer.domElement.addEventListener('pointerdown', (ev)=>{
  if(!grassPainting) return;
  // Ne bloquer l'orbite caméra QUE si le clic tombe bien sur la maquette
  // (n'importe où dessus) — un clic à côté, sur le fond, doit continuer à
  // permettre de déplacer la caméra normalement pendant qu'on peint, sans
  // avoir à quitter l'outil Gazon.
  if(!isClickOnModel(ev)){ grassPointerActive = false; return; }
  controls.enabled = false;
  grassPointerActive = true;
  paintGrassAt(ev, ev.button===2);
});
}
window.addEventListener('pointermove', (ev)=>{
  if(!grassPainting || !grassPointerActive) return;
  paintGrassAt(ev, ev.buttons===2);
});
window.addEventListener('pointerup', ()=>{
  const wasPainting = grassPointerActive;
  grassPointerActive = false;
  if(grassPainting) controls.enabled = true;
  if(wasPainting) updateSiteStats(); // recalcul une seule fois en fin de trait (getImageData coûteux)
});
// Menu contextuel du navigateur bloqué PARTOUT (fenêtre entière, canvas 3D,
// UI, chips de labels, etc.) : le clic droit est utilisé dans l'outil pour
// orbiter/peindre/déplacer selon le mode, un clic droit qui ferait
// apparaître le menu du navigateur par-dessus casserait ces interactions.
// Écouteur unique sur `window`, en phase de capture pour intercepter avant
// tout autre gestionnaire (les gestionnaires spécifiques, comme celui des
// chips de labels ci-dessous, gardent leur propre logique métier — seul le
// menu natif du navigateur est supprimé ici).
window.addEventListener('contextmenu', (ev)=> ev.preventDefault(), true);

const brushBtns = {
  small: document.getElementById('brush-small'),
  medium: document.getElementById('brush-medium'),
  large: document.getElementById('brush-large'),
};
const BRUSH_SIZES = { small:6, medium:12, large:20 };
function setBrushSize(key){
  grassBrushRadius = BRUSH_SIZES[key];
  Object.entries(brushBtns).forEach(([k,btn])=> btn.classList.toggle('active', k===key));
}
function updateBrushRowState(){
  // Grisé si le pinceau gazon n'est pas l'outil actif, bleu électrique sur
  // la taille en cours d'utilisation sinon.
  Object.values(brushBtns).forEach(btn=> btn.classList.toggle('disabled', !grassPainting));
}
brushBtns.small.addEventListener('click', ()=> setBrushSize('small'));
brushBtns.medium.addEventListener('click', ()=> setBrushSize('medium'));
brushBtns.large.addEventListener('click', ()=> setBrushSize('large'));
setBrushSize('medium');
updateBrushRowState();
