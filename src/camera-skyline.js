// Sous-mode "Skyline" de la Vue Globale — 4 élévations orthogonales
// (Nord/Sud/Est/Ouest) façon dessin technique. Extrait d'index.html.
//
// index.html reste responsable de la bascule sur exitGlobalView() (il
// enveloppe cette fonction pour réinitialiser le sous-mode Skyline à la
// sortie de la Vue Globale — voir resetSkylineSubMode() ci-dessous, appelée
// depuis ce wrapper resté dans index.html car un module ES ne peut pas
// réaffecter une variable/fonction qui vit dans un autre module).
//
// Dépendances externes non encore extraites, injectées via
// initCameraSkyline() : exitPedestrianMode, getPedestrianModeActive.

import * as THREE from "three";
import { camera, controls, renderer, orthoCamera, worldRoot, siteRoot, globalRoot, buildings } from './state.js';
import { traverseFramed, framingBox } from './scene-utils.js';

let exitPedestrianMode, getPedestrianModeActive;
export function initCameraSkyline(deps){
  ({ exitPedestrianMode, getPedestrianModeActive } = deps);
}

/* ------------------------------------------------------------
   SOUS-MODE "SKYLINE" DE LA VUE GLOBALE — 4 élévations orthogonales
   (Nord/Sud/Est/Ouest) façon dessin technique : la maquette (place_de_milan
   + global.glb) et les nouveaux bâtiments dessinés sont projetées en caméra
   orthographique strictement alignée sur l'axe cardinal choisi.
   RENDU : contour visible SEULEMENT (silhouette des masses + lignes de
   recouvrement entre volumes à profondeurs différentes) — PAS le wireframe
   de chaque arête de chaque mesh, qui serait illisible. Technique : on
   rend la profondeur de la maquette dans une texture (caméra ortho =
   profondeur linéaire), puis un filtre de détection de contours (Sobel sur
   la profondeur) ne fait ressortir que les endroits où la profondeur "saute"
   — c'est-à-dire exactement les limites visibles des volumes, comme dans un
   vrai dessin d'élévation avec suppression des lignes cachées. Fond noir
   uni, contour clair pour un contraste maximal, + graduation de hauteur
   (traits tous les 10 m, plus épais tous les 50 m, valeurs à gauche).
   Le Nord de la maquette est -Z (voir orientCameraNorth plus haut).
   ------------------------------------------------------------ */
export let skylineDirection = null; // null='Maquette 3D' (vue libre normale), sinon 'nord'|'sud'|'est'|'ouest'
let skylineSavedState = null; // position/cible/contrôles avant la 1ère bascule en Skyline, pour retour exact
const skylineRulerCanvas = document.getElementById('skyline-ruler-overlay');
const skylineRulerCtx = skylineRulerCanvas.getContext('2d');
const skylineModeBar = document.getElementById('skyline-mode-bar');
const SKYLINE_BG_COLOR = new THREE.Color(0x05070a); // fond noir (légèrement teinté) du mode Skyline
const SKYLINE_LINE_COLOR = new THREE.Color(0xf2f7fb); // contour clair, contraste maximal sur fond noir
// Direction de vue (caméra -> cible) pour chaque bouton, exprimée dans le
// repère Three.js de la maquette (Nord = -Z, voir plus haut).
export const SKYLINE_VIEW_DIRS = {
  nord:  new THREE.Vector3(0, 0,  1), // caméra au Nord (-Z), regarde vers +Z
  sud:   new THREE.Vector3(0, 0, -1), // caméra au Sud  (+Z), regarde vers -Z
  est:   new THREE.Vector3(-1, 0, 0), // caméra à l'Est  (+X), regarde vers -X
  ouest: new THREE.Vector3( 1, 0, 0), // caméra à l'Ouest(-X), regarde vers +X
};
// Regroupe tous les meshes "de fond" à considérer pour une élévation
// technique : maquette de base + maquette élargie (Vue Globale) + bâtiments
// dessinés dans l'outil. On exclut volontairement les éléments d'interface
// 3D (halos, marqueurs, gizmo, aperçus d'outils, arbres, véhicules/piétons,
// étiquettes) qui n'ont pas leur place dans un plan/coupe technique.
const SKYLINE_EXCLUDE_NAME_RE = /halo|marker|highlight|preview|hazard|guide|cursor|gizmo|decal|vertex|ring/i;
function collectSkylineMeshes(){
  const meshes = [];
  const roots = [siteRoot, globalRoot, ...buildings.map(b=>b.group)];
  roots.forEach(root=>{
    if(!root) return;
    traverseFramed(root, o=>{ // sans le bâti de contexte (Bâtis 3D 2018) : il masquerait tout le quartier
      if(o.isMesh && o.visible && o.geometry && !SKYLINE_EXCLUDE_NAME_RE.test(o.name||'')){
        meshes.push(o);
      }
    });
  });
  return meshes;
}
// Scène isolée, dédiée au calcul de la silhouette : un THREE.Mesh brut par
// mesh source (même géométrie PARTAGÉE — jamais clonée/disposée — juste sa
// matrice monde figée), sans matériau visuel, sans lumière, sans brouillard.
// Ça permet de rendre UNIQUEMENT la profondeur de la maquette+bâtiments,
// indépendamment de tout ce qui vit par ailleurs dans `scene`.
//
// NOTE : une variante précédente calculait une distance caméra "maison" en
// mètres pour éviter le codage logarithmique du depth buffer principal —
// ça n'a rien changé (l'artefact restait localisé aux 2 mêmes tours), donc
// ce n'était pas un problème de précision de profondeur.
// LA VRAIE CAUSE (confirmée en comparant Skyline Est/Ouest sur les MÊMES
// bâtiments) : ces 2 tours ont un capuchon de toit qui, vu d'un côté,
// disparaît par endroits (trous → petits pointillés isolés en Est) et vu de
// l'autre côté, laisse voir des faces obliques qui ne devraient pas être
// visibles (triangle/diagonale parasite en Ouest). C'est la signature
// classique d'un mesh à FACE UNIQUE (normales orientées dans un seul sens) :
// vu depuis l'arrière, ses faces sont "culled" par défaut et n'écrivent
// aucune profondeur → trous dans la silhouette côté Est ; vu de face, on
// voit la vraie géométrie de la sous-face oblique du capuchon qui n'était
// pas censée être visible de champ → artefact en Ouest.
// Fix : on force le rendu en DOUBLE FACE (`side: DoubleSide`) pour la passe
// de silhouette, afin que CHAQUE mesh écrive sa profondeur correctement
// quel que soit l'angle de vue cardinal, plus un léger `polygonOffset` pour
// limiter le z-fighting entre surfaces coïncidentes, et une PASSE DE
// NETTOYAGE dédiée (voir plus bas) qui élimine les points isolés résiduels
// sans toucher aux vraies arêtes (qui forment toujours une ligne continue).
const skylineSilhouetteScene = new THREE.Scene();
const skylineSilhouetteMaterial = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide,
  polygonOffset:true, polygonOffsetFactor:1, polygonOffsetUnits:1,
});
function buildSkylineSilhouette(){
  while(skylineSilhouetteScene.children.length) skylineSilhouetteScene.remove(skylineSilhouetteScene.children[0]);
  collectSkylineMeshes().forEach(o=>{
    o.updateWorldMatrix(true, false);
    const m = new THREE.Mesh(o.geometry, skylineSilhouetteMaterial);
    m.matrixAutoUpdate = false;
    m.matrix.copy(o.matrixWorld);
    skylineSilhouetteScene.add(m);
  });
}
// Cible de rendu profondeur (comme dans la version validée) + pipeline en
// DEUX passes plein-écran : (1) détection de contour brute par différence de
// profondeur, (2) nettoyage/érosion + colorisation. Séparer les deux permet
// à la passe 2 de "voir" le voisinage de chaque pixel de contour pour juger
// s'il fait partie d'une vraie ligne continue ou d'un artefact isolé.
let skylineDepthTarget = null;
function ensureSkylineDepthTarget(w, h){
  if(skylineDepthTarget && skylineDepthTarget.width===w && skylineDepthTarget.height===h) return;
  if(skylineDepthTarget) skylineDepthTarget.dispose();
  const dt = new THREE.DepthTexture(w, h);
  dt.type = THREE.UnsignedIntType;
  skylineDepthTarget = new THREE.WebGLRenderTarget(w, h, { depthTexture: dt, depthBuffer:true, stencilBuffer:false });
}
let skylineMaskTarget = null;
function ensureSkylineMaskTarget(w, h){
  if(skylineMaskTarget && skylineMaskTarget.width===w && skylineMaskTarget.height===h) return;
  if(skylineMaskTarget) skylineMaskTarget.dispose();
  skylineMaskTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer:false, stencilBuffer:false });
}
const SKYLINE_QUAD_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// Passe 1 — masque de contour brut (niveau de gris, aucune couleur).
const skylineEdgeMaskMaterial = new THREE.ShaderMaterial({
  uniforms:{ tDepth:{value:null}, texel:{value:new THREE.Vector2()} },
  vertexShader: SKYLINE_QUAD_VS,
  fragmentShader:`
    uniform sampler2D tDepth; uniform vec2 texel;
    varying vec2 vUv;
    float sampleDepth(vec2 offset){ return texture2D(tDepth, vUv + offset*texel).x; }
    void main(){
      float d = sampleDepth(vec2(0.0));
      float diff = 0.0;
      diff += abs(d - sampleDepth(vec2( 1.0,  0.0)));
      diff += abs(d - sampleDepth(vec2(-1.0,  0.0)));
      diff += abs(d - sampleDepth(vec2( 0.0,  1.0)));
      diff += abs(d - sampleDepth(vec2( 0.0, -1.0)));
      float edge = smoothstep(0.0006, 0.0022, diff);
      gl_FragColor = vec4(edge, edge, edge, 1.0);
    }
  `,
  depthTest:false, depthWrite:false,
});
// Passe 2 — nettoyage (érosion) + colorisation finale. Un vrai contour
// architectural est une LIGNE CONTINUE : chacun de ses pixels a plusieurs
// voisins également marqués dans le masque brut. Un artefact isolé
// (poussière ponctuelle due à une géométrie quasi coïncidente) n'a presque
// aucun voisin marqué et se fait éliminer ici, sans qu'on touche à
// l'épaisseur ni à la couleur des vraies arêtes.
const skylineDenoiseMaterial = new THREE.ShaderMaterial({
  uniforms:{ tMask:{value:null}, texel:{value:new THREE.Vector2()}, edgeColor:{value:SKYLINE_LINE_COLOR} },
  vertexShader: SKYLINE_QUAD_VS,
  fragmentShader:`
    uniform sampler2D tMask; uniform vec2 texel; uniform vec3 edgeColor;
    varying vec2 vUv;
    float m(vec2 offset){ return texture2D(tMask, vUv + offset*texel).r; }
    void main(){
      float center = m(vec2(0.0));
      if(center < 0.35) discard;
      float count = 0.0;
      count += step(0.35, m(vec2(-1.0,-1.0)));
      count += step(0.35, m(vec2( 0.0,-1.0)));
      count += step(0.35, m(vec2( 1.0,-1.0)));
      count += step(0.35, m(vec2(-1.0, 0.0)));
      count += step(0.35, m(vec2( 1.0, 0.0)));
      count += step(0.35, m(vec2(-1.0, 1.0)));
      count += step(0.35, m(vec2( 0.0, 1.0)));
      count += step(0.35, m(vec2( 1.0, 1.0)));
      if(count < 3.0) discard; // isolé : probablement un artefact, on l'écarte
      gl_FragColor = vec4(edgeColor, center);
    }
  `,
  transparent:true, depthTest:false, depthWrite:false,
});
const skylineFsQuadScene = new THREE.Scene();
const skylineFsQuadCamera = new THREE.Camera();
const skylineFsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2,2), skylineEdgeMaskMaterial);
skylineFsQuadScene.add(skylineFsQuad);
// Effectue le rendu Skyline complet (silhouette contour sur fond noir) dans
// le canvas WebGL visible — utilisé à la fois par la boucle animate() et par
// l'export PNG, pour un résultat strictement identique.
export function renderSkylineView(){
  const w = renderer.domElement.width, h = renderer.domElement.height;
  ensureSkylineDepthTarget(w, h);
  ensureSkylineMaskTarget(w, h);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color(); renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();

  // Passe 0 : profondeur brute de la maquette (caméra ortho, silhouette isolée).
  renderer.setRenderTarget(skylineDepthTarget);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(skylineSilhouetteScene, orthoCamera);

  // Passe 1 : masque de contour brut, avant nettoyage.
  skylineEdgeMaskMaterial.uniforms.tDepth.value = skylineDepthTarget.depthTexture;
  skylineEdgeMaskMaterial.uniforms.texel.value.set(1/w, 1/h);
  skylineFsQuad.material = skylineEdgeMaskMaterial;
  renderer.setRenderTarget(skylineMaskTarget);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(skylineFsQuadScene, skylineFsQuadCamera);

  // Passe 2 : nettoyage + colorisation, composée sur le fond noir final.
  renderer.setRenderTarget(null);
  renderer.setClearColor(SKYLINE_BG_COLOR, 1);
  renderer.clear(true, true, false);
  skylineDenoiseMaterial.uniforms.tMask.value = skylineMaskTarget.texture;
  skylineDenoiseMaterial.uniforms.texel.value.set(1/w, 1/h);
  skylineFsQuad.material = skylineDenoiseMaterial;
  renderer.render(skylineFsQuadScene, skylineFsQuadCamera);

  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
}
function skylineButtonFor(dir){ return document.getElementById(dir ? `btn-skyline-${dir}` : 'btn-skyline-3d'); }
function setSkylineActiveButton(dir){
  skylineModeBar.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
  const btn = skylineButtonFor(dir); if(btn) btn.classList.add('active');
}
const skylineFrameCenter = new THREE.Vector3();
// Cadre la caméra orthographique pour englober toute la maquette (worldRoot),
// vue le long de l'axe cardinal `dir`, avec une marge à gauche réservée à la
// graduation de hauteur (voir drawSkylineRuler). Le near/far est resserré au
// plus près de l'épaisseur réelle de la maquette selon l'axe de vue : la
// détection de contours par profondeur (renderSkylineView) a besoin d'un
// intervalle near/far serré pour rester précise (une plage near/far trop
// large "écrase" la précision de la texture de profondeur).
export function frameOrthoOnSkyline(dir){
  const box = framingBox(THREE, worldRoot);
  if(box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const viewDir = SKYLINE_VIEW_DIRS[dir];
  const horizExtent = Math.abs(viewDir.x) > 0.5 ? size.z : size.x; // largeur perçue selon l'axe de vue
  const depthExtent = Math.abs(viewDir.x) > 0.5 ? size.x : size.z; // épaisseur de la maquette le long de l'axe de vue
  const vertExtent = size.y;
  const margin = 1.15;
  const halfH = Math.max(vertExtent, 10) * margin / 2;
  // Marge à gauche pour la graduation, en unités monde (proportionnelle à la
  // largeur du viewport pour rester cohérente au redimensionnement).
  const rulerFrac = 0.12;
  const halfW = (Math.max(horizExtent, 10) * margin / 2) / (1 - rulerFrac);
  const standoff = 100; // recul de la caméra hors de la maquette, pour garder de la marge devant le near plane
  const half = depthExtent/2 + standoff;
  orthoCamera.position.copy(center).addScaledVector(viewDir, -half);
  orthoCamera.up.set(0,1,0);
  orthoCamera.lookAt(center);
  const aspect = window.innerWidth / window.innerHeight;
  let vh = halfH, vw = halfW;
  if(vw / vh < aspect){ vw = vh * aspect; } else { vh = vw / aspect; }
  // Décale le cadre vers la droite pour libérer la bande de gauche réservée
  // à la graduation (left plus négatif que right n'est large).
  const shift = vw * rulerFrac;
  orthoCamera.left = -vw - shift; orthoCamera.right = vw - shift;
  orthoCamera.top = vh; orthoCamera.bottom = -vh;
  orthoCamera.near = standoff*0.5; orthoCamera.far = depthExtent + standoff*1.5;
  orthoCamera.updateProjectionMatrix();
  skylineFrameCenter.copy(center);
}
export function setSkylineDirection(dir){
  if(dir === skylineDirection) return;
  const wasActive = !!skylineDirection;
  if(dir && !wasActive){
    // Première bascule 3D -> Skyline : mémorise l'état pour restauration au retour sur "Maquette 3D".
    skylineSavedState = {
      position: camera.position.clone(), target: controls.target.clone(),
      controlsEnabled: controls.enabled,
    };
    if(getPedestrianModeActive()) exitPedestrianMode();
  }
  skylineDirection = dir;
  setSkylineActiveButton(dir);
  document.body.classList.toggle('skyline-view-active', !!dir);
  if(dir){
    buildSkylineSilhouette(); // capture l'état courant de la maquette AVANT de la masquer
    worldRoot.visible = false; // la scène normale n'est plus rendue en Skyline (voir animate()/renderSkylineView)
    controls.enabled = false;
    frameOrthoOnSkyline(dir);
  } else {
    worldRoot.visible = true;
    if(skylineSavedState){
      camera.position.copy(skylineSavedState.position);
      controls.target.copy(skylineSavedState.target);
      controls.enabled = skylineSavedState.controlsEnabled;
      controls.update();
    }
    skylineSavedState = null;
  }
}
skylineModeBar.querySelectorAll('button').forEach(btn=>{
  btn.addEventListener('click', ()=> setSkylineDirection(btn.dataset.skyline || null));
});

// Dessine la graduation de hauteur (traits horizontaux tous les 10 m, plus
// épais tous les 50 m, valeur affichée à gauche), lisible sur le fond noir
// du mode Skyline. Un plan horizontal du monde à hauteur h se projette
// TOUJOURS en une ligne parfaitement horizontale à l'écran dans une vue
// orthogonale alignée sur un axe cardinal (up=(0,1,0)) : on calcule donc sa
// position écran une seule fois via la projection caméra, peu importe X/Z
// du point choisi. Fonction générique (ctx/largeur/hauteur/échelle en
// paramètres) pour être réutilisable telle quelle par l'export PNG.
export function drawSkylineRulerOn(ctx, w, h, scale){
  scale = scale || 1;
  const box = framingBox(THREE, worldRoot);
  if(box.isEmpty()) return;
  const hMin = Math.floor(box.min.y/10)*10 - 10;
  const hMax = Math.ceil(box.max.y/10)*10 + 10;
  const p = new THREE.Vector3();
  ctx.font = `600 ${12*scale}px 'Space Grotesk', sans-serif`;
  ctx.textBaseline = 'middle';
  for(let hVal=hMin; hVal<=hMax; hVal+=10){
    p.set(skylineFrameCenter.x, hVal, skylineFrameCenter.z);
    p.project(orthoCamera);
    if(p.y < -1.05 || p.y > 1.05) continue; // hors écran verticalement
    const sy = (1 - (p.y*0.5+0.5)) * h;
    const isMajor = Math.round(hVal) % 50 === 0;
    ctx.strokeStyle = isMajor ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.22)';
    ctx.lineWidth = (isMajor ? 2 : 1) * scale;
    ctx.beginPath();
    ctx.moveTo(isMajor ? 0 : 74*scale, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
    if(isMajor){
      const chipW = 64*scale, chipH = 20*scale;
      ctx.fillStyle = 'rgba(5,7,10,.92)';
      ctx.strokeStyle = 'rgba(46,232,255,.55)'; ctx.lineWidth = 1*scale;
      ctx.fillRect(4*scale, sy-chipH/2, chipW, chipH);
      ctx.strokeRect(4*scale, sy-chipH/2, chipW, chipH);
      ctx.fillStyle = '#2ee8ff';
      ctx.fillText(`${Math.round(hVal)} m`, 10*scale, sy);
    }
  }
}
export function drawSkylineRuler(){
  if(!skylineDirection) return;
  const w = window.innerWidth, h = window.innerHeight;
  if(skylineRulerCanvas.width!==w || skylineRulerCanvas.height!==h){
    skylineRulerCanvas.width = w; skylineRulerCanvas.height = h;
  }
  skylineRulerCtx.clearRect(0,0,w,h);
  drawSkylineRulerOn(skylineRulerCtx, w, h, 1);
}

// Appelée depuis index.html par le wrapper de exitGlobalView() : remet la
// Vue Globale sur la maquette 3D classique (jamais figée sur une élévation)
// à chaque sortie.
export function resetSkylineSubMode(){
  if(skylineDirection) setSkylineDirection(null);
}
