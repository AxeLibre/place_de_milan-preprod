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
const FADE_SECONDS = 1.1;           // durée d'un fondu complet d'une lumière du pool (allumage ou extinction), adouci en S
const OUT_OF_VIEW_PENALTY = 6;      // multiplicateur de distance² pour une source hors champ
const HYSTERESIS = 0.7;             // une source déjà allumée garde sa place tant que score×0.7 reste dans le top N
const POOL_CAPACITY = 1024;         // nombre max de flaques (sources) — un seul draw call par couche, quel que soit leur nombre
const PUDDLE_STRENGTH = 5;          // couche MULTIPLICATIVE : sol × (1 + lumière) — même teinte qu'une vraie lumière
const PUDDLE_GLOW = 0.55;           // couche ADDITIVE : lueur visible même sur l'asphalte sombre (que la couche multiplicative n'éclaire presque pas)
const PUDDLE_GLOW_SATURATION = 1.5; // >1 : teinte de la lueur additive plus saturée (plus chaude), pour ne pas virer au blanc/froid
const PUDDLE_LIT_DIMMING = 0.6;     // atténuation de la flaque quand une vraie lumière éclaire déjà cette zone
const PUDDLE_LIFT = 0.06;           // m au-dessus du sol, évite le z-fighting

const sources = new Map();          // id -> { id, pos:Vector3 (repère de worldRoot), groundY, color:Color, intensity, distance, decay }
let poolGroup = null;
let pool = [];                      // { light, src, f (progression du fondu 0..1) }
let active = false;
let puddles = null, puddlesGlow = null, puddleIndex = new Map(), puddlesDirty = true;
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
    pool.push({ light, src:null, f:0 });
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI/2);
  // Mélange MULTIPLICATIF : résultat = sol × (1 + lumière). C'est ce que fait
  // une vraie lumière (éclairement × couleur du sol) — la flaque a donc la même
  // teinte chaude que la lampe éclairée, alors qu'un mélange additif y ajoutait
  // la couleur brute de la lampe (qui virait au blanc/froid après le tone
  // mapping). Pas de brouillard propre : le sol qu'elle éclaire est déjà brumeux.
  // PAS de vertexColors/customProgramCacheKey ici (contrairement à trees.js/
  // index.html) : ANCIENNE VERSION DE CE COMMENTAIRE FAUSSE — appliqués ici
  // "par précaution" en pensant reproduire le correctif du tronc des arbres,
  // ils ont en réalité rendu TOUTE flaque invisible (confirmé : matériau
  // identique SANS ces deux lignes → flaque bien visible ; AVEC → rien à
  // l'écran, dans TOUS les réglages essayés — profondeur, culling, layers,
  // etc. tous corrects par ailleurs). Cause exacte non isolée (probablement
  // une interaction vertexColors × CustomBlending/AdditiveBlending propre à
  // MeshBasicMaterial, absente du MeshLambertMaterial utilisé pour les
  // arbres/piétons, où ce correctif reste lui légitime et vérifié). On
  // revient donc à `material.color` uniforme (blanc) : la teinte/intensité
  // par lampadaire (calculée plus bas dans rebuildPuddles) n'est plus
  // appliquée pour l'instant — mieux vaut une flaque visible et neutre
  // qu'une flaque invisible mais "correctement" teintée.
  const mat = new THREE.MeshBasicMaterial({
    map: makePuddleTexture(), color: 0xffffff, transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const tex = mat.map;
  // Deuxième couche : lueur ADDITIVE. La couche multiplicative reproduit la
  // teinte d'une vraie lumière, mais n'éclaire presque pas un sol très sombre
  // (asphalte) — la flaque devenait quasi invisible, surtout en vue de dessus.
  // fog:false : le mélange de brouillard de Three.js ajoutait la couleur du
  // brouillard (bleutée) sur TOUT le carré de la flaque en mode additif — des
  // carrés bleus visibles de loin. L'atténuation par la distance est faite à la
  // main (voir fadeByFog), sur la couleur de chaque instance.
  const glowMat = new THREE.MeshBasicMaterial({
    map: tex, color: 0xffffff, transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  function makeLayer(material, order){
    const m = new THREE.InstancedMesh(geo, material, POOL_CAPACITY);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for(let i=0;i<POOL_CAPACITY;i++) m.setColorAt(i, _c.setRGB(0,0,0));
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = order;
    m.castShadow = false; m.receiveShadow = false;
    m.visible = false;
    worldRoot.add(m);
    return m;
  }
  puddles = makeLayer(mat, 4);
  puddlesGlow = makeLayer(glowMat, 5);
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
    // Source "LOD seulement" (ex. lumières "global-light" de global.glb) : rien
    // qu'une flaque de lumière au sol, JAMAIS de vraie lumière du pool.
    lodOnly: !!opts.lodOnly,
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
function setPuddlesVisible(on){ if(puddles){ puddles.visible = on; puddlesGlow.visible = on; } }
export function setNightActive(on){
  on = !!on;
  if(on === active && pool.length){ setPuddlesVisible(on); return; }
  active = on;
  pool.forEach(p=>{
    p.light.visible = on;
    p.src = null; p.f = 0; p.light.intensity = 0;
  });
  setPuddlesVisible(on);
  puddlesDirty = true;
}
export function isNightActive(){ return active; }

const _frustum = new THREE.Frustum();
const _mat = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

// À appeler à chaque frame. `focus` = point regardé (repère de worldRoot),
// `cam` = caméra réellement affichée (pour le test de champ).
export function updateNightLights(dt, focus, cam, fog){
  if(!active || !pool.length) return;

  if(puddlesDirty) rebuildPuddles();

  // 1. Score de chaque source (plus petit = plus prioritaire).
  _mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_mat);
  const held = new Set(); pool.forEach(p=>{ if(p.src) held.add(p.src.id); });
  const ranked = [];
  sources.forEach(s=>{
    if(s.lodOnly) return; // pas candidate à une vraie lumière
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

  // 2. Fondu (allumage / extinction) des lumières affectées, adouci en S. Une
  // lumière dont la source n'est plus voulue s'éteint PROGRESSIVEMENT avant
  // d'être libérée ; si elle redevient voulue entre-temps, elle se rallume
  // depuis son niveau actuel (pas de saut).
  const step = dt / FADE_SECONDS;
  pool.forEach(p=>{
    if(!p.src){ p.light.intensity = 0; return; }
    const want = sources.has(p.src.id) && wanted.has(p.src.id);
    p.f = want ? Math.min(1, p.f + step) : Math.max(0, p.f - step);
    p.light.intensity = p.src.intensity * (p.f*p.f*(3 - 2*p.f));
    if(!want && p.f <= 0){ p.src = null; p.light.intensity = 0; }
  });

  // 3. Affecte les sources voulues qui n'ont pas encore de lumière.
  const assigned = new Set(); pool.forEach(p=>{ if(p.src) assigned.add(p.src.id); });
  for(const r of ranked){
    if(!wanted.has(r.s.id) || assigned.has(r.s.id)) continue;
    const slot = pool.find(p=> !p.src);
    if(!slot) break; // toutes occupées (fondus en cours) : au prochain passage
    slot.src = r.s; slot.f = 0;
    slot.light.intensity = 0;
    slot.light.position.copy(r.s.pos);
    slot.light.color.copy(r.s.color);
    slot.light.distance = r.s.distance;
    slot.light.decay = r.s.decay;
    assigned.add(r.s.id);
  }

  // 4. Atténue la flaque des sources qui ont (en cours d'allumage) une vraie
  // lumière : elles éclairent déjà réellement ce qui les entoure. Suit le même
  // fondu que la lumière, donc la flaque s'estompe pendant qu'elle s'allume.
  const lit = new Map();
  pool.forEach(p=>{ if(p.src) lit.set(p.src.id, p.f*p.f*(3 - 2*p.f)); });
  let touched = false;
  puddleIndex.forEach((i, id)=>{
    const s = sources.get(id); if(!s) return;
    const f = 1 - PUDDLE_LIT_DIMMING * (lit.get(id) || 0);
    const pw = Math.min(1.6, Math.sqrt(s.intensity / 18)) * f * fadeByFog(s, cam, fog);
    const k = PUDDLE_STRENGTH * pw;
    puddles.setColorAt(i, _c.setRGB(s.color.r * k, s.color.g * k, s.color.b * k));
    const g = PUDDLE_GLOW * pw;
    puddlesGlow.setColorAt(i, _c.setRGB(
      Math.pow(s.color.r, PUDDLE_GLOW_SATURATION) * g,
      Math.pow(s.color.g, PUDDLE_GLOW_SATURATION) * g,
      Math.pow(s.color.b, PUDDLE_GLOW_SATURATION) * g));
    touched = true;
  });
  if(touched){
    if(puddles.instanceColor) puddles.instanceColor.needsUpdate = true;
    if(puddlesGlow.instanceColor) puddlesGlow.instanceColor.needsUpdate = true;
  }
}

// Atténuation d'une flaque avec la distance, sur les mêmes bornes que le
// brouillard de la scène (0 = éteinte, 1 = pleine) : une flaque n'apparaît pas
// plus loin que le brouillard n'a fini de tout voiler.
function fadeByFog(s, cam, fog){
  if(!fog) return 1;
  const d = cam.position.distanceTo(s.pos);
  const t = Math.min(1, Math.max(0, (d - fog.near) / Math.max(1e-3, fog.far - fog.near)));
  return 1 - t*t*(3 - 2*t);
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
    puddlesGlow.setMatrixAt(i, _m4);
    puddleIndex.set(s.id, i);
    i++;
  });
  puddles.count = i; puddlesGlow.count = i;
  puddles.instanceMatrix.needsUpdate = true;
  puddlesGlow.instanceMatrix.needsUpdate = true;
}
