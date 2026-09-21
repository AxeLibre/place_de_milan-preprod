// ÉCLAIRAGE DE NUIT PAR POOL DE LUMIÈRES + FLAQUES DE LUMIÈRE "BAKÉES".
//
// Problème : Three.js évalue CHAQUE lumière ponctuelle visible pour CHAQUE
// pixel de CHAQUE matériau éclairé (aucun culling par portée). La maquette
// compte ~43 lampadaires + jusqu'à 10 posés par l'utilisateur : la nuit, la
// boucle de lumières dominait le coût de rendu (mesuré : ~0,45 ms de GPU par
// lumière, soit ~18 ms/image pour 43). Et ajouter/retirer une seule lumière
// visible change le nombre de lumières du shader : TOUS les matériaux sont
// alors recompilés (c'est ce qui faisait ramer la pose d'un lampadaire).
//
// Solution en deux couches :
//  1. FLAQUES DE LUMIÈRE (équivalent d'un éclairage "baké" en émissif) : chaque
//     lampadaire projette au sol une flaque de lumière additive (un dégradé
//     radial posé sur le sol sous la lampe). TOUS les lampadaires en ont une,
//     en permanence, pour un seul draw call et un coût par pixel quasi nul :
//     la place reste éclairée partout, comme avec l'éclairage complet.
//  2. POOL DE VRAIES LUMIÈRES : un NOMBRE FIXE (POOL_SIZE) de lumières
//     ponctuelles, créées une fois et jamais ajoutées/retirées la nuit (donc
//     aucune recompilation), réaffectées en fondu (~0,3 s) aux lampadaires les
//     plus proches de la vue. Elles apportent l'éclairage réel (façades,
//     véhicules, piétons, relief) là où l'on regarde de près ; la flaque du
//     lampadaire concerné est alors atténuée pour ne pas doubler l'éclairage.
//
// Les "sources" sont enregistrées par index.html (lumières ponctuelles de
// place_de_milan.glb) et par l'outil Aménagements (lampadaires posés).

import * as THREE from "three";
import { worldRoot } from './state.js';

export const POOL_SIZE = 8;
const FADE_SECONDS = 0.3;
const OUT_OF_VIEW_PENALTY = 6;      // multiplicateur de distance² pour une source hors champ
const HYSTERESIS = 0.7;             // une source déjà allumée garde sa place tant que score×0.7 reste dans le top N
const POOL_CAPACITY = 128;          // nombre max de flaques (sources)
const MAX_INTENSITY = 60;           // plus forte intensité gérée (sert au calcul de la vitesse de fondu)
const PUDDLE_STRENGTH = 5;          // luminosité des flaques (réglable : plus haut = sol plus éclairé)
const PUDDLE_LIT_DIMMING = 0.6;     // atténuation de la flaque quand une vraie lumière éclaire déjà cette zone
const PUDDLE_LIFT = 0.06;           // m au-dessus du sol, évite le z-fighting

const sources = new Map();          // id -> { id, pos:Vector3 (repère de worldRoot), groundY, color:Color, intensity, distance, decay }
let poolGroup = null;
let pool = [];                      // { light, src, cur, target }
let active = false;
let puddles = null, puddleIndex = new Map(), puddlesDirty = true;
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _sc = new THREE.Vector3(), _c = new THREE.Color();

// Rayon de la flaque selon la puissance de la lampe (18 → ~17 m, 60 → ~27 m).
function puddleRadius(s){ return 5 + Math.sqrt(Math.max(1, s.intensity)) * 3.6; }

function makePuddleTexture(){
  // Dégradé en NIVEAUX DE GRIS opaque (et non en transparence) : la flaque est
  // rendue en mélange multiplicatif (voir initNightLights), dont le facteur
  // vient de la couleur du texel — 1 = pleine lumière, 0 = aucune.
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64,64,0, 64,64,64);
  // Profil proche d'une décroissance physique (fort au pied du mât, doux sur
  // les bords), nul au bord de la texture.
  grad.addColorStop(0.00, '#ffffff');
  grad.addColorStop(0.15, '#b8b8b8');
  grad.addColorStop(0.35, '#5c5c5c');
  grad.addColorStop(0.60, '#1f1f1f');
  grad.addColorStop(0.85, '#080808');
  grad.addColorStop(1.00, '#000000');
  g.fillStyle = '#000'; g.fillRect(0,0,128,128);
  g.fillStyle = grad; g.fillRect(0,0,128,128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; // valeurs linéaires : le profil dessiné est celui appliqué
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
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI/2);
  // Mélange MULTIPLICATIF : résultat = sol × (1 + lumière). C'est ce que fait
  // une vraie lumière (éclairement × couleur du sol) — la flaque a donc la même
  // teinte chaude que la lampe éclairée, alors qu'un mélange additif y ajoutait
  // la couleur brute de la lampe (qui virait au blanc/froid après le tone
  // mapping). Pas de brouillard propre : le sol qu'elle éclaire est déjà brumeux.
  const mat = new THREE.MeshBasicMaterial({
    map: makePuddleTexture(), color: 0xffffff, transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  puddles = new THREE.InstancedMesh(geo, mat, POOL_CAPACITY);
  puddles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for(let i=0;i<POOL_CAPACITY;i++) puddles.setColorAt(i, _c.setRGB(0,0,0));
  puddles.count = 0;
  puddles.frustumCulled = false;
  puddles.renderOrder = 4;
  puddles.castShadow = false; puddles.receiveShadow = false;
  puddles.visible = false;
  worldRoot.add(puddles);
}

// `opts.groundY` : altitude du sol sous la lampe (mesurée par l'appelant) ;
// à défaut, 4 m sous la lumière (hauteur d'un lampadaire courant).
export function registerSource(id, pos, opts){
  opts = opts || {};
  // Source déjà connue (ex. lampadaire qu'on déplace) : mise à jour SUR PLACE,
  // pour que la lumière du pool qui lui est affectée continue de la suivre.
  if(sources.has(id)){ updateSourcePosition(id, pos, opts.groundY); return; }
  sources.set(id, {
    id, pos: pos.clone(),
    groundY: opts.groundY !== undefined ? opts.groundY : pos.y - 4,
    color: new THREE.Color(opts.color !== undefined ? opts.color : 0xffe0b0),
    intensity: opts.intensity !== undefined ? opts.intensity : 18,
    distance: opts.distance !== undefined ? opts.distance : 110,
    decay: opts.decay !== undefined ? opts.decay : 1.1,
  });
  puddlesDirty = true;
}
export function updateSourcePosition(id, pos, groundY){
  const s = sources.get(id);
  if(!s) return;
  s.pos.copy(pos);
  s.groundY = groundY !== undefined ? groundY : pos.y - 4;
  // Une lumière déjà affectée suit immédiatement sa source.
  pool.forEach(p=>{ if(p.src === s) p.light.position.copy(pos); });
  puddlesDirty = true;
}
export function unregisterSource(id){
  if(sources.delete(id)) puddlesDirty = true;
}
export function unregisterSourcesWithPrefix(prefix){
  let any = false;
  for(const id of Array.from(sources.keys())){ if(id.startsWith(prefix)){ sources.delete(id); any = true; } }
  if(any) puddlesDirty = true;
}
export function sourceCount(){ return sources.size; }

// Bascule jour/nuit. Seul endroit où la visibilité des lumières change : le
// nombre de lumières du shader ne varie donc qu'ici (une recompilation, déjà
// masquée par le spinner de la bascule jour/nuit), jamais à la pose d'un
// lampadaire ni pendant la navigation.
export function setNightActive(on){
  on = !!on;
  if(on === active && pool.length){ if(puddles) puddles.visible = on; return; }
  active = on;
  pool.forEach(p=>{
    p.light.visible = on;
    p.src = null; p.cur = 0; p.target = 0; p.light.intensity = 0;
  });
  if(puddles) puddles.visible = on;
  puddlesDirty = true;
}
export function isNightActive(){ return active; }

const _frustum = new THREE.Frustum();
const _mat = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

// À appeler à chaque frame. `focus` = point regardé (repère de worldRoot),
// `cam` = caméra réellement affichée (pour le test de champ).
export function updateNightLights(dt, focus, cam){
  if(!active || !pool.length) return;

  if(puddlesDirty) rebuildPuddles();

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

  // 4. Atténue la flaque des sources qui ont (en cours d'allumage) une vraie
  // lumière : elles éclairent déjà réellement ce qui les entoure.
  const lit = new Map();
  pool.forEach(p=>{ if(p.src && p.src.intensity > 0) lit.set(p.src.id, Math.min(1, p.cur / p.src.intensity)); });
  let touched = false;
  puddleIndex.forEach((i, id)=>{
    const s = sources.get(id); if(!s) return;
    const f = 1 - PUDDLE_LIT_DIMMING * (lit.get(id) || 0);
    const k = PUDDLE_STRENGTH * f * Math.min(1.6, Math.sqrt(s.intensity / 18));
    puddles.setColorAt(i, _c.setRGB(s.color.r * k, s.color.g * k, s.color.b * k));
    touched = true;
  });
  if(touched && puddles.instanceColor) puddles.instanceColor.needsUpdate = true;
}

// Flaques de toutes les sources (un seul draw call).
function rebuildPuddles(){
  puddlesDirty = false;
  puddleIndex.clear();
  let i = 0;
  sources.forEach(s=>{
    if(i >= POOL_CAPACITY) return;
    const r = puddleRadius(s);
    _p.set(s.pos.x, s.groundY + PUDDLE_LIFT, s.pos.z);
    _sc.set(r*2, 1, r*2);
    _m4.compose(_p, _q.identity(), _sc);
    puddles.setMatrixAt(i, _m4);
    puddleIndex.set(s.id, i);
    i++;
  });
  puddles.count = i;
  puddles.instanceMatrix.needsUpdate = true;
}
