// ÉCLAIRAGE DE NUIT PAR POOL DE LUMIÈRES.
//
// Problème : Three.js évalue CHAQUE lumière ponctuelle visible pour CHAQUE
// pixel de CHAQUE matériau éclairé (aucun culling par portée). La maquette
// compte ~43 lampadaires + jusqu'à 10 posés par l'utilisateur : la nuit, la
// boucle de lumières dominait le coût de rendu (mesuré : ~0,45 ms de GPU par
// lumière, soit ~18 ms/image pour 43). Et ajouter/retirer une seule lumière
// visible change le nombre de lumières du shader : TOUS les matériaux sont
// alors recompilés (c'est ce qui faisait ramer la pose d'un lampadaire).
//
// Solution : un NOMBRE FIXE (POOL_SIZE) de vraies lumières ponctuelles, créées
// une fois pour toutes et jamais ajoutées/retirées/masquées la nuit (donc plus
// aucune recompilation), sans cesse réaffectées aux lampadaires les plus
// pertinents pour la vue courante (les plus proches du point regardé, avec
// pénalité hors champ). Un changement d'affectation se fait en fondu
// (extinction puis rallumage ailleurs, ~0,3 s) : pas de "pop" brutal, ce qui
// était la raison de l'abandon de l'ancien plafonnement. Tous les autres
// lampadaires restent signalés par un petit halo lumineux (un seul draw call
// pour l'ensemble, coût négligeable).
//
// Les "sources" sont enregistrées par index.html (lumières ponctuelles de
// place_de_milan.glb) et par l'outil Aménagements (lampadaires posés).

import * as THREE from "three";
import { worldRoot } from './state.js';

export const POOL_SIZE = 12;
const FADE_SECONDS = 0.3;
const OUT_OF_VIEW_PENALTY = 6;      // multiplicateur de distance² pour une source hors champ
const HYSTERESIS = 0.7;             // une source déjà allumée garde sa place tant que score×0.7 reste dans le top N
const GLOW_CAPACITY = 128;
const MAX_INTENSITY = 60;           // plus forte intensité gérée (sert au calcul de la vitesse de fondu)

const sources = new Map();          // id -> { id, pos:Vector3 (repère de worldRoot), color:Color, intensity, distance, decay }
let poolGroup = null;
let pool = [];                      // { light, src, cur, target }
let active = false;
let glow = null, glowPositions = null, glowColors = null, glowDirty = true;

function makeGlowTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32,32,0, 32,32,32);
  grad.addColorStop(0, 'rgba(255,240,205,1)');
  grad.addColorStop(0.25, 'rgba(255,214,150,.55)');
  grad.addColorStop(1, 'rgba(255,190,110,0)');
  g.fillStyle = grad; g.fillRect(0,0,64,64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// À appeler une fois worldRoot créé (voir index.html).
export function initNightLights(){
  poolGroup = new THREE.Group(); poolGroup.name = 'nightLightPool';
  worldRoot.add(poolGroup);
  for(let i=0;i<POOL_SIZE;i++){
    const light = new THREE.PointLight(0xffe0b0, 0, 110, 1.1);
    light.castShadow = false;
    light.visible = false; // (dés)activé UNIQUEMENT par setNightActive : jamais en cours de nuit
    poolGroup.add(light);
    pool.push({ light, src:null, cur:0, target:0 });
  }
  glowPositions = new Float32Array(GLOW_CAPACITY*3);
  glowColors = new Float32Array(GLOW_CAPACITY*3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(glowPositions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(glowColors, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  const mat = new THREE.PointsMaterial({
    size: 7, sizeAttenuation: true, map: makeGlowTexture(), vertexColors: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  });
  glow = new THREE.Points(geo, mat);
  glow.frustumCulled = false;
  glow.renderOrder = 4;
  glow.visible = false;
  worldRoot.add(glow);
}

export function registerSource(id, pos, opts){
  opts = opts || {};
  // Source déjà connue (ex. lampadaire qu'on déplace) : mise à jour SUR PLACE,
  // pour que la lumière du pool qui lui est affectée continue de la suivre.
  if(sources.has(id)){ updateSourcePosition(id, pos); return; }
  sources.set(id, {
    id, pos: pos.clone(),
    color: new THREE.Color(opts.color !== undefined ? opts.color : 0xffe0b0),
    intensity: opts.intensity !== undefined ? opts.intensity : 18,
    distance: opts.distance !== undefined ? opts.distance : 110,
    decay: opts.decay !== undefined ? opts.decay : 1.1,
  });
  glowDirty = true;
}
export function updateSourcePosition(id, pos){
  const s = sources.get(id);
  if(!s) return;
  s.pos.copy(pos);
  // Une lumière déjà affectée suit immédiatement sa source.
  pool.forEach(p=>{ if(p.src === s) p.light.position.copy(pos); });
  glowDirty = true;
}
export function unregisterSource(id){
  if(sources.delete(id)) glowDirty = true;
}
export function unregisterSourcesWithPrefix(prefix){
  let any = false;
  for(const id of Array.from(sources.keys())){ if(id.startsWith(prefix)){ sources.delete(id); any = true; } }
  if(any) glowDirty = true;
}
export function sourceCount(){ return sources.size; }

// Bascule jour/nuit. Seul endroit où la visibilité des lumières change : le
// nombre de lumières du shader ne varie donc qu'ici (une recompilation, déjà
// masquée par le spinner de la bascule jour/nuit), jamais à la pose d'un
// lampadaire ni pendant la navigation.
export function setNightActive(on){
  on = !!on;
  if(on === active && pool.length) { if(glow) glow.visible = on; return; }
  active = on;
  pool.forEach(p=>{
    p.light.visible = on;
    p.src = null; p.cur = 0; p.target = 0; p.light.intensity = 0;
  });
  if(glow) glow.visible = on;
  glowDirty = true;
}
export function isNightActive(){ return active; }

const _frustum = new THREE.Frustum();
const _mat = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

// À appeler à chaque frame. `focus` = point regardé (repère de worldRoot),
// `cam` = caméra réellement affichée (pour le test de champ).
export function updateNightLights(dt, focus, cam){
  if(!active || !pool.length) return;

  if(glowDirty) rebuildGlow();

  // 1. Score de chaque source (plus petit = plus prioritaire).
  _mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_mat);
  const held = new Set(); pool.forEach(p=>{ if(p.src) held.add(p.src.id); });
  const ranked = [];
  sources.forEach(s=>{
    const dx = s.pos.x - focus.x, dz = s.pos.z - focus.z;
    let score = dx*dx + dz*dz;
    _sphere.center.copy(s.pos); _sphere.radius = 25;
    // worldRoot est un repère "local" : pour ce test on suppose worldRoot sans
    // transformation (cas de la maquette) ; sinon la pénalité est simplement
    // moins précise, sans conséquence fonctionnelle.
    if(!_frustum.intersectsSphere(_sphere)) score *= OUT_OF_VIEW_PENALTY;
    if(held.has(s.id)) score *= HYSTERESIS;
    ranked.push({ s, score });
  });
  ranked.sort((a,b)=> a.score - b.score);
  const wanted = new Set(ranked.slice(0, POOL_SIZE).map(r=>r.s.id));

  // 2. Fondu des lumières déjà affectées ; libération de celles éteintes.
  const rate = MAX_INTENSITY / FADE_SECONDS; // intensité par seconde
  pool.forEach(p=>{
    if(p.src && (!sources.has(p.src.id) || !wanted.has(p.src.id))) p.target = 0;
    else if(p.src) p.target = p.src.intensity;
    if(p.cur < p.target) p.cur = Math.min(p.target, p.cur + rate*dt);
    else if(p.cur > p.target) p.cur = Math.max(p.target, p.cur - rate*dt);
    p.light.intensity = p.cur;
    if(p.src && p.target === 0 && p.cur <= 0.001){ p.src = null; p.cur = 0; }
  });

  // 3. Affecte les sources voulues qui n'ont pas encore de lumière.
  const assigned = new Set(); pool.forEach(p=>{ if(p.src && p.target > 0) assigned.add(p.src.id); });
  for(const r of ranked){
    if(!wanted.has(r.s.id) || assigned.has(r.s.id)) continue;
    const slot = pool.find(p=> !p.src);
    if(!slot) break; // toutes occupées (fondus en cours) : au prochain passage
    slot.src = r.s; slot.cur = 0; slot.target = r.s.intensity;
    slot.light.position.copy(r.s.pos);
    slot.light.color.copy(r.s.color);
    slot.light.distance = r.s.distance;
    slot.light.decay = r.s.decay;
    assigned.add(r.s.id);
  }
}

// Halos de toutes les sources (un seul draw call). Le halo des sources qui ont
// une vraie lumière est atténué : elles éclairent déjà réellement ce qui les
// entoure.
function rebuildGlow(){
  glowDirty = false;
  let i = 0;
  sources.forEach(s=>{
    if(i >= GLOW_CAPACITY) return;
    glowPositions[i*3] = s.pos.x; glowPositions[i*3+1] = s.pos.y; glowPositions[i*3+2] = s.pos.z;
    const k = 0.55;
    glowColors[i*3] = s.color.r*k; glowColors[i*3+1] = s.color.g*k; glowColors[i*3+2] = s.color.b*k;
    i++;
  });
  glow.geometry.setDrawRange(0, i);
  glow.geometry.attributes.position.needsUpdate = true;
  glow.geometry.attributes.color.needsUpdate = true;
}
