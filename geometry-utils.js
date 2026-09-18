// Fonctions géométriques PURES (aucune dépendance à l'état de la scène/app) :
// tests/points-dans-polygone, snapping sur la zone d'implantation ou sur un
// autre bâtiment, réparation de contour contre un polygone concave, aires,
// offsets, etc. Extrait de index.html (découpage en modules ES).

// Point le plus proche de `pt` sur le segment [a,b].
export function closestPointOnSegment(pt, a, b){
  const abx=b.x-a.x, abz=b.z-a.z;
  const lenSq = abx*abx+abz*abz;
  if(lenSq < 1e-12) return {x:a.x, z:a.z};
  let t = ((pt.x-a.x)*abx + (pt.z-a.z)*abz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x+abx*t, z: a.z+abz*t };
}
export function distanceToPolygonBoundary(pt, poly){
  let best = Infinity;
  for(let i=0;i<poly.length;i++){
    const a = poly[i], b = poly[(i+1)%poly.length];
    const proj = closestPointOnSegment(pt, a, b);
    best = Math.min(best, Math.hypot(proj.x-pt.x, proj.z-pt.z));
  }
  return best;
}
// Le test "rayon horizontal" (even-odd rule) classique est fiable loin du
// contour, mais NUMÉRIQUEMENT INSTABLE pour un point posé pile sur une arête
// (ou aligné avec un sommet) : selon l'arrondi flottant, il peut basculer
// dedans/dehors de façon imprévisible — et ça peut créer une "limite fantôme"
// ailleurs dans la forme (rien à voir avec l'arête la plus proche), typique
// des polygones concaves. Solution : si le test brut dit "dehors" mais que le
// point est en réalité à quelques centimètres ou moins de n'importe quelle
// arête du contour, on le considère valide quand même — c'est la même
// tolérance que le clamp, appliquée en amont pour ne jamais bloquer un point
// qui vise légitimement le bord.
// Tolérance de distance au bord (voir plus haut) : 3 cm. Valeur inlinée
// directement (pas de constante séparée) pour éviter tout risque de
// "temporal dead zone" si cette fonction est appelée tôt au chargement,
// avant qu'une déclaration plus bas dans le fichier n'ait été exécutée.
export function pointInPolygon(pt, poly, tolerance){
  if(tolerance===undefined) tolerance = 0.03;
  let inside = false;
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const xi=poly[i].x, zi=poly[i].z, xj=poly[j].x, zj=poly[j].z;
    const intersect = ((zi>pt.z)!==(zj>pt.z)) &&
      (pt.x < (xj-xi)*(pt.z-zi)/(zj-zi)+xi);
    if(intersect) inside = !inside;
  }
  if(inside) return true;
  if(tolerance>0 && poly.length>=3) return distanceToPolygonBoundary(pt, poly) <= tolerance;
  return false;
}
// Ramène `pt` à l'intérieur (ou pile sur le bord) du polygone, plutôt que de
// rejeter purement et simplement un point à l'extérieur. Sans ça, un point
// qui vient d'un raycast (jamais parfaitement identique aux coordonnées du
// polygone au bit près) peut se retrouver à quelques dixièmes de millimètre
// à l'extérieur — invisible à l'oeil — et se faire rejeter en bloc : le
// sommet reste alors figé alors que le joueur/l'utilisateur vise pourtant
// bien la bonne zone. Ici on ne rejette jamais : si `pt` est dehors, on
// renvoie le point du contour le plus proche, pour que le déplacement
// "glisse" le long de la limite au lieu de se bloquer net.
export function clampPointToPolygon(pt, poly){
  if(poly.length<3) return pt;
  if(pointInPolygon(pt, poly)) return pt;
  let best = null, bestDist = Infinity;
  for(let i=0;i<poly.length;i++){
    const a = poly[i], b = poly[(i+1)%poly.length];
    const proj = closestPointOnSegment(pt, a, b);
    const d = Math.hypot(proj.x-pt.x, proj.z-pt.z);
    if(d < bestDist){ bestDist = d; best = proj; }
  }
  return best;
}
// Sommet du polygone le plus proche de `pt`, seulement s'il est à moins de
// `radius` unités — sert à "aimanter" un sommet de bâtiment directement SUR
// un vrai sommet du polygone, en copiant ses coordonnées telles quelles
// (exactement le mécanisme fiable de "Emprise pleine" : une copie directe,
// aucun calcul de clamp/glissement qui pourrait introduire une imprécision).
export function nearestZoneVertex(pt, zone, radius){
  let best = null, bestDist = radius;
  for(const v of zone){
    const d = Math.hypot(v.x-pt.x, v.z-pt.z);
    if(d <= bestDist){ bestDist = d; best = v; }
  }
  return best ? { x: best.x, z: best.z } : null;
}
export const VERTEX_SNAP_RADIUS = 4; // unités de scène (~4 m) : assez large pour "attraper" le sommet visé sans viser au pixel près
// Distance sous laquelle un point visé est aimanté PILE sur le bord du
// polygone (projection exacte), au lieu d'être simplement toléré "à peu
// près dessus". C'est cette dernière tolérance (pointInPolygon/clamp,
// quelques cm) qui laissait passer un point resté légèrement en retrait —
// la fameuse "marge fantôme" — puisqu'un point jugé "assez proche" pour
// être valide n'était jamais recalé sur le bord lui-même.
export const EDGE_SNAP_RADIUS = 1.5; // unités de scène (~1.5 m)
// Point de guidage UNIQUE, utilisé à la fois pour le tracé d'un nouveau
// bâtiment et pour le glissement d'un sommet existant — exactement le même
// mécanisme fiable que "Emprise pleine" (copie/projection exacte des
// coordonnées du polygone, jamais un point "presque" dessus) :
//   1) sommet du polygone à portée -> aimantation exacte dessus.
//   2) sinon bord du polygone à portée -> projection exacte SUR le bord.
//   3) sinon, à l'intérieur -> le point tel quel.
//   4) sinon (hors polygone, loin d'un bord) -> clamp classique.
export function snapPointToZone(pt, zone){
  if(zone.length<3) return {x:pt.x, z:pt.z};
  const vertex = nearestZoneVertex(pt, zone, VERTEX_SNAP_RADIUS);
  if(vertex) return vertex;
  if(distanceToPolygonBoundary(pt, zone) <= EDGE_SNAP_RADIUS){
    let best=null, bestDist=Infinity;
    for(let i=0;i<zone.length;i++){
      const a=zone[i], b=zone[(i+1)%zone.length];
      const proj = closestPointOnSegment(pt,a,b);
      const d = Math.hypot(proj.x-pt.x, proj.z-pt.z);
      if(d<bestDist){ bestDist=d; best=proj; }
    }
    return best;
  }
  return clampPointToPolygon(pt, zone);
}
// Même mécanisme d'aimantation (sommet à portée -> copie exacte, sinon bord à
// portée -> projection exacte dessus) mais SANS le clamp final à l'intérieur
// du contour de référence : un volume supérieur (décroché) doit pouvoir
// légitimement déborder de son support (jusqu'à 30%, voir
// shrinkPolygonToFitOverlap) — seul l'alignement sur les sommets/bords du
// volume inférieur nous intéresse ici, pas la contrainte "rester dedans".
export function snapToFootprintEdges(pt, footprint){
  if(!footprint || footprint.length<3) return {x:pt.x, z:pt.z};
  const vertex = nearestZoneVertex(pt, footprint, VERTEX_SNAP_RADIUS);
  if(vertex) return vertex;
  if(distanceToPolygonBoundary(pt, footprint) <= EDGE_SNAP_RADIUS){
    let best=null, bestDist=Infinity;
    for(let i=0;i<footprint.length;i++){
      const a=footprint[i], b=footprint[(i+1)%footprint.length];
      const proj = closestPointOnSegment(pt,a,b);
      const d = Math.hypot(proj.x-pt.x, proj.z-pt.z);
      if(d<bestDist){ bestDist=d; best=proj; }
    }
    return best;
  }
  return {x:pt.x, z:pt.z};
}
// Vérifie que l'intégralité du contour du bâtiment (pas seulement ses sommets)
// reste dans le polygone d'implantation, en échantillonnant chaque arête.
export function polygonFullyInsideZone(pts, zone){
  for(let i=0;i<pts.length;i++){
    const a = pts[i], b = pts[(i+1)%pts.length];
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/1.0));
    for(let s=0;s<=steps;s++){
      const t=s/steps;
      const p = {x:a.x+(b.x-a.x)*t, z:a.z+(b.z-a.z)*t};
      if(!pointInPolygon(p, zone)) return false;
    }
  }
  return true;
}
// Vérifie qu'UN SEUL segment [a,b] (pas tout un polygone fermé) reste dans la
// zone — utilisé pendant le tracé d'un nouveau bâtiment, où la forme n'est pas
// encore fermée.
export function segmentFullyInsideZone(a, b, zone){
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/1.0));
  for(let s=0;s<=steps;s++){
    const t=s/steps;
    const p = {x:a.x+(b.x-a.x)*t, z:a.z+(b.z-a.z)*t};
    if(!pointInPolygon(p, zone)) return false;
  }
  return true;
}
// Fait glisser un point de `from` vers `to` le long du segment [from,to], en
// s'arrêtant au point le plus loin encore accepté par `validAtT(t)`, plutôt
// que d'accepter `to` tel quel (qui peut faire sortir une ARÊTE du polygone
// même si `to` lui-même est valide — cas d'un polygone concave, cf. clamp par
// simple point). Recherche dichotomique : `from` doit être valide (t=0), et
// si `to` (t=1) l'est aussi, on le retourne direct sans chercher plus loin.
export function slideToValid(from, to, validAtT){
  if(validAtT(1)) return { x:to.x, z:to.z };
  if(!validAtT(0)) return { x:from.x, z:from.z };
  let lo=0, hi=1, best = { x:from.x, z:from.z };
  for(let i=0;i<20;i++){
    const t = (lo+hi)/2;
    const mid = { x: from.x+(to.x-from.x)*t, z: from.z+(to.z-from.z)*t };
    if(validAtT(t)){ best = mid; lo = t; } else { hi = t; }
  }
  return best;
}
// ==== Réparation "définitive" d'une arête contre un polygone concave ====
// slideToValid() ci-dessus suppose qu'une arête ne bascule qu'une fois entre
// valide/invalide en avançant de `from` vers `to`. FAUX pour un polygone
// concave : les deux extrémités peuvent être valides (chacune sur le bord
// réel) alors que tout le milieu du segment sort par un renfoncement — la
// dichotomie s'arrête alors bien trop tôt et ampute le bâtiment inutilement.
//
// Le cas le plus courant (vérifié avec les vraies données du projet) n'est
// même pas une arête qui "traverse" franchement une autre arête du polygone :
// c'est un unique SOMMET RENTRANT (concave) du polygone que la ligne droite
// coupe au plus court. Détecter une traversée d'arête classique rate donc ce
// cas. La bonne approche : repérer sur quelle arête du polygone repose
// chaque extrémité, puis insérer les sommets du polygone entre les deux, en
// suivant le contour réel dans le sens le plus court (comparaison de
// longueur totale) plutôt que de deviner.
// (fonctions désormais inutiles retirées : l'ancien "hug" par chaînage
// d'indices de sommets pouvait mal tourner sur un contour dense/irrégulier
// issu d'un mesh Blender, remplacé par l'échantillonnage ci-dessous, robuste
// par construction — aucune notion de sens/indice de départ à deviner.)
// Répare l'arête [a,b] : si elle reste dans la zone ET qu'aucune extrémité
// n'est posée sur le bord, ne change rien (arête intérieure normale). Sinon,
// hugue le bord réel par ÉCHANTILLONNAGE + projection individuelle de chaque
// échantillon sur le point le plus proche du polygone (clampPointToPolygon) —
// méthode volontairement simple et robuste : aucune notion d'indice de départ/
// sens à deviner (un chaînage par indices peut mal tourner sur un contour
// dense/irrégulier issu d'un mesh Blender et produire un contour en dents de
// scie). Fonctionne aussi bien pour rattraper une arête qui sort de la zone
// (polygone concave) que pour coller au plus près un léger renflement convexe
// du bord entre deux points pourtant valides chacun de leur côté (la "marge
// fantôme"). Retourne les points de a (exclu) à b (inclus).
export const ON_BOUNDARY_EPS = 0.05;
// Nettoie un polygone : supprime les points consécutifs quasi confondus
// (qu'un hug répété peut laisser). NE RÉORDONNE JAMAIS les points : l'ordre
// de tracé fait foi, un tri (ex. par angle polaire) casserait toute forme
// non convexe en repliant le contour sur lui-même.
export function cleanPolygonPoints(pts, epsilon=0.06){
  if(!pts || pts.length<3) return null;
  const cleaned = [];
  for(let i=0;i<pts.length;i++){
    const cur = pts[i];
    const prev = cleaned.length ? cleaned[cleaned.length-1] : null;
    if(!prev || Math.hypot(cur.x-prev.x, cur.z-prev.z) > epsilon){
      cleaned.push({x:cur.x, z:cur.z});
    }
  }
  // referme proprement : si le dernier point est quasi confondu avec le premier, on le retire
  if(cleaned.length>3 && Math.hypot(cleaned[0].x-cleaned[cleaned.length-1].x, cleaned[0].z-cleaned[cleaned.length-1].z) <= epsilon){
    cleaned.pop();
  }
  return cleaned.length>=3 ? cleaned : null;
}
// Distance perpendiculaire d'un point à une droite (a,b).
export function perpDistance(p, a, b){
  const dx=b.x-a.x, dz=b.z-a.z;
  const len = Math.hypot(dx,dz);
  if(len<1e-9) return Math.hypot(p.x-a.x, p.z-a.z);
  return Math.abs((p.x-a.x)*dz - (p.z-a.z)*dx) / len;
}
// Simplification de Ramer-Douglas-Peucker appliquée à un contour FERMÉ.
// Corrige le problème "impossible à sélectionner" : quand un bâtiment est
// déplacé/redimensionné par-dessus un angle rentrant du polygone
// d'implantation, hugBoundarySampled() ré-échantillonne chaque arête
// concernée tous les 0,4 m (jusqu'à 80 points), ce qui peut faire exploser un
// bâtiment de 6 sommets à plusieurs centaines. La quasi-totalité de ces
// points sont quasiment alignés (ils suivent un segment de bord globalement
// droit) : on les fusionne agressivement ici, sans jamais perdre un VRAI
// angle (un coin réel du polygone a toujours une distance perpendiculaire
// bien supérieure à epsilon, donc RDP le conserve).
export function simplifyClosedPolygon(points, epsilon=0.2){
  if(!points || points.length<=4) return points;
  function rdp(pts, eps){
    if(pts.length<3) return pts;
    let maxD=0, idx=0;
    const start=pts[0], end=pts[pts.length-1];
    for(let i=1;i<pts.length-1;i++){
      const d = perpDistance(pts[i], start, end);
      if(d>maxD){ maxD=d; idx=i; }
    }
    if(maxD>eps){
      const left = rdp(pts.slice(0,idx+1), eps);
      const right = rdp(pts.slice(idx), eps);
      return left.slice(0,-1).concat(right);
    }
    return [start, end];
  }
  // Traité comme un chemin ouvert refermé sur lui-même (p0 → … → p0), pour
  // que la simplification s'applique aussi à l'arête de fermeture — sinon un
  // angle rentrant tout près du premier sommet pourrait être ignoré.
  const loop = points.concat([points[0]]);
  const simplified = rdp(loop, epsilon);
  simplified.pop(); // retire le point de fermeture dupliqué
  return simplified.length>=3 ? simplified : points;
}
export function isOnZoneBoundary(p, zone){
  return zone.length>=3 && distanceToPolygonBoundary(p, zone) <= ON_BOUNDARY_EPS;
}
// ==== "Hug" du bord réel entre deux points ====
// Deux cas bien différents, traités par deux méthodes différentes :
//
// 1) Les DEUX extrémités sont posées sur le bord (cas du tracé qui longe le
//    contour, clic après clic) -> on rejoue les VRAIS sommets du polygone
//    `zone` compris entre les deux, dans le sens le plus court. Borné par
//    zone.length, quel que soit le nombre de clics le long du bord — c'est
//    ce qui corrige l'explosion à plusieurs milliers de sommets qu'on avait
//    avec l'ancien ré-échantillonnage systématique tous les 0,4 m.
//
// 2) Un SEUL sommet rentrant du polygone coupe le segment (typiquement une
//    arête dont les deux extrémités sont valides mais qui traverse un
//    renfoncement concave par le milieu) -> ici le "sens le plus court le
//    long du bord" n'a AUCUN rapport avec le point réellement traversé (les
//    deux extrémités peuvent se projeter n'importe où sur le contour), et
//    appliquer la méthode 1 dans ce cas produit un raccourci qui coupe le
//    bâtiment de travers (triangle en diagonale au lieu de suivre l'angle
//    réel). On revient donc ici au ré-échantillonnage local du segment
//    lui-même, qui suit la trajectoire réellement dessinée.
export function buildZoneArcTable(zone){
  const arcs = [0];
  let acc = 0;
  for(let i=0;i<zone.length;i++){
    const a = zone[i], b = zone[(i+1)%zone.length];
    acc += Math.hypot(b.x-a.x, b.z-a.z);
    if(i < zone.length-1) arcs.push(acc);
  }
  return { arcs, perimeter: acc }; // arcs[i] = distance le long du contour de zone[0] à zone[i]
}
export function zoneBoundaryArc(pt, zone, arcs){
  let bestDist = Infinity, bestArc = 0;
  for(let i=0;i<zone.length;i++){
    const a = zone[i], b = zone[(i+1)%zone.length];
    const segLen = Math.hypot(b.x-a.x, b.z-a.z);
    const proj = closestPointOnSegment(pt, a, b);
    const d = Math.hypot(proj.x-pt.x, proj.z-pt.z);
    if(d < bestDist){
      bestDist = d;
      const t = segLen>1e-9 ? Math.hypot(proj.x-a.x, proj.z-a.z)/segLen : 0;
      bestArc = arcs[i] + t*segLen;
    }
  }
  return bestArc;
}
// Sommets de `zone` strictement entre les positions d'arc `fromArc` et
// `toArc` (sens croissant, avec retour à zéro après le périmètre), triés
// dans cet ordre de parcours.
export function zoneVerticesBetween(zone, arcs, perimeter, fromArc, toArc){
  const span = (toArc - fromArc + perimeter) % perimeter;
  const items = [];
  for(let i=0;i<zone.length;i++){
    const rel = (arcs[i] - fromArc + perimeter) % perimeter;
    if(rel > 1e-6 && rel < span - 1e-6) items.push({ p: zone[i], rel });
  }
  items.sort((a,b)=>a.rel-b.rel);
  return items.map(it=>({x:it.p.x, z:it.p.z}));
}
// Cas 1 : les deux points sont déjà sur le bord -> on rejoue le contour réel.
// Bug corrigé ici : choisir systématiquement "le sens le plus court" pour
// CETTE arête, isolément, ignore tout le reste du bâtiment déjà tracé — si le
// bâtiment longe le bord sur une bonne partie de son pourtour, la fermeture
// finale (dernier point -> premier point) peut alors repartir dans le
// MAUVAIS sens et retraverser des sommets déjà posés plus tôt (d'où les
// points dupliqués observés : le contour repassait sur lui-même). On préfère
// donc le sens qui ne réutilise AUCUN point déjà présent dans le bâtiment ;
// on ne retombe sur "le plus court" que si les deux sens sont sans conflit
// (ou les deux en conflit, auquel cas aucune règle simple ne fait mieux).
export function hugBoundaryVertices(a, b, zone, avoidPoints){
  const { arcs, perimeter } = buildZoneArcTable(zone);
  if(perimeter<1e-6) return [{x:b.x, z:b.z}];
  const arcA = zoneBoundaryArc(a, zone, arcs);
  const arcB = zoneBoundaryArc(b, zone, arcs);
  const fwd = (arcB - arcA + perimeter) % perimeter;
  const bwd = (arcA - arcB + perimeter) % perimeter;
  const fwdPts = zoneVerticesBetween(zone, arcs, perimeter, arcA, arcB);
  const bwdPts = zoneVerticesBetween(zone, arcs, perimeter, arcB, arcA).reverse();
  const hasConflict = (pts) => avoidPoints && avoidPoints.length && pts.some(p =>
    avoidPoints.some(q => Math.hypot(p.x-q.x, p.z-q.z) < 0.1));
  const fwdBad = hasConflict(fwdPts), bwdBad = hasConflict(bwdPts);
  let out;
  if(fwdBad && !bwdBad) out = bwdPts;
  else if(bwdBad && !fwdBad) out = fwdPts;
  else out = fwd <= bwd ? fwdPts : bwdPts;
  out.push({x:b.x, z:b.z});
  return out;
}
// Cas 2 : dip concave ponctuel -> ré-échantillonnage local du segment tracé,
// borné à 80 points (un seul sommet rentrant à rattraper, jamais un tracé
// entier le long d'un bord — donc pas de risque d'explosion ici).
export function hugBoundarySampled(a, b, zone){
  const dist = Math.hypot(b.x-a.x, b.z-a.z);
  if(dist < 1e-6) return [{x:b.x, z:b.z}];
  const steps = Math.max(2, Math.min(80, Math.ceil(dist/0.4)));
  const out = [];
  let prev = a;
  for(let s=1;s<=steps;s++){
    const t = s/steps;
    const raw = { x:a.x+(b.x-a.x)*t, z:a.z+(b.z-a.z)*t };
    const isLast = s===steps;
    // Ne corrige QUE les échantillons réellement HORS de la zone — pas
    // seulement "proches" d'un bord (ancien critère : distance <= 3 m à
    // N'IMPORTE QUEL bord). Un point valide à l'intérieur, même à deux mètres
    // d'un bord, ne doit jamais être tiré de force dessus : le bord le plus
    // proche à vol d'oiseau peut appartenir à une tout autre partie du
    // contour (de l'autre côté d'un renfoncement), ce qui accrochait le
    // sommet dessus et créait une excursion aberrante (aller-retour vers un
    // point du contour sans rapport avec le tracé réel).
    const near = pointInPolygon(raw, zone) ? raw : clampPointToPolygon(raw, zone);
    const pt = isLast ? {x:b.x, z:b.z} : near; // le tout dernier échantillon EST b, jamais une approximation
    if(Math.hypot(pt.x-prev.x, pt.z-prev.z) > 0.06){ out.push(pt); prev = pt; }
  }
  if(!out.length) out.push({x:b.x, z:b.z});
  return out;
}
// Ordre des vérifications important : on ne hugue QUE si la ligne droite
// entre a et b sort réellement de la zone. Bug corrigé ici : la version
// précédente forçait un hug (Cas 1, suivi des vrais sommets) dès que les DEUX
// extrémités touchaient le bord, même quand le segment direct entre elles
// était un chord parfaitement valide à l'intérieur — le contour partait alors
// faire tout le tour du polygone au lieu de rester droit, d'où les grandes
// excursions/aller-retours observés (le bâtiment se retrouvait "creux").
export function repairEdgeAgainstZone(a, b, zone, avoidPoints){
  if(zone.length<3) return [{x:b.x, z:b.z}];
  if(segmentFullyInsideZone(a, b, zone)) return [{x:b.x, z:b.z}]; // chord valide : rien à corriger
  const bothOnBoundary = isOnZoneBoundary(a, zone) && isOnZoneBoundary(b, zone);
  return bothOnBoundary ? hugBoundaryVertices(a, b, zone, avoidPoints) : hugBoundarySampled(a, b, zone);
}
// Applique repairEdgeAgainstZone() à chaque arête d'un contour FERMÉ (chaque
// point relié au suivant, et le dernier au premier). Pour chaque arête, les
// points déjà accumulés dans `result` sont transmis comme `avoidPoints` afin
// que le hug ne reparte jamais dans le sens qui les recouperait (voir
// hugBoundaryVertices).
export function repairClosedPolygonAgainstZone(points, zone){
  if(zone.length<3) return points.map(p=>({x:p.x,z:p.z}));
  const result = [{x:points[0].x, z:points[0].z}];
  for(let i=0;i<points.length;i++){
    const a = points[i], b = points[(i+1)%points.length];
    const extra = repairEdgeAgainstZone(a, b, zone, result);
    // le dernier point ajouté par repairEdgeAgainstZone == b ; on ne le
    // rajoute pas une seconde fois quand on boucle sur le premier point.
    if(i < points.length-1) result.push(...extra);
    else result.push(...extra.slice(0,-1)); // referme sur result[0] déjà présent
  }
  return result;
}
// Surface au sol de l'emprise (formule du lacet / shoelace) en m².
export function polygonAreaXZ(pts){
  if(!pts || pts.length<3) return 0;
  let a = 0;
  for(let i=0;i<pts.length;i++){
    const p1 = pts[i], p2 = pts[(i+1)%pts.length];
    a += p1.x*p2.z - p2.x*p1.z;
  }
  return Math.abs(a)/2;
}
// Décale chaque sommet d'un polygone fermé vers l'intérieur d'une distance
// `dist` (mètres), via une jointure "miter" simple sur les bissectrices des
// arêtes adjacentes. Suffisant pour des emprises convexes/quasi-convexes
// typiques d'un bâtiment ; pas un offset robuste type Clipper mais évite
// toute dépendance externe.
export function offsetPolygonInwardXZ(pts, dist){
  const n = pts.length;
  if(n<3) return pts.slice();
  function offsetWithSign(sign){
    const out = [];
    for(let i=0;i<n;i++){
      const prev = pts[(i-1+n)%n], cur = pts[i], next = pts[(i+1)%n];
      const e1 = {x:cur.x-prev.x, z:cur.z-prev.z};
      const e2 = {x:next.x-cur.x, z:next.z-cur.z};
      const l1 = Math.hypot(e1.x,e1.z)||1, l2 = Math.hypot(e2.x,e2.z)||1;
      const n1 = {x:sign*(-e1.z/l1), z:sign*(e1.x/l1)};
      const n2 = {x:sign*(-e2.z/l2), z:sign*(e2.x/l2)};
      let bis = {x:n1.x+n2.x, z:n1.z+n2.z};
      const bl = Math.hypot(bis.x,bis.z);
      if(bl < 1e-6){ out.push({x:cur.x+n1.x*dist, z:cur.z+n1.z*dist}); continue; }
      bis.x/=bl; bis.z/=bl;
      const cosHalf = Math.max(0.15, (n1.x*bis.x+n1.z*bis.z));
      const push = dist/cosHalf;
      out.push({x:cur.x+bis.x*push, z:cur.z+bis.z*push});
    }
    return out;
  }
  // On ne suppose pas le sens de parcours (CW/CCW) du contour tracé par
  // l'utilisateur : on calcule le décalage dans les deux sens et on retient
  // celui qui RÉDUIT effectivement la surface (c'est la définition même
  // d'un retrait vers l'intérieur) — évite le bug où un contour tracé dans
  // l'autre sens produisait un décalage vers l'extérieur, invalidant
  // l'incrustation "gazon" (toiture entièrement couleur BATIMENTS).
  const outerArea = polygonAreaXZ(pts);
  const candA = offsetWithSign(1);
  const candB = offsetWithSign(-1);
  const areaA = polygonAreaXZ(candA);
  const areaB = polygonAreaXZ(candB);
  return areaA <= areaB ? candA : candB;
}

// Centroïde (moyenne des sommets) d'un polygone — suffisant pour un point
// de "rétrécissement" vers l'intérieur, pas besoin du centroïde d'aire exact.
export function polygonCentroidXZ(pts){
  const c = pts.reduce((s,p)=>({x:s.x+p.x, z:s.z+p.z}), {x:0,z:0});
  return { x:c.x/pts.length, z:c.z/pts.length };
}
// Estime la proportion de la surface de `poly` qui tombe HORS de `basePts`,
// par échantillonnage sur une grille régulière de sa bbox (simple, robuste
// aux formes concaves, pas besoin d'un vrai clipping polygone/polygone —
// largement assez précis pour une contrainte visuelle comme celle-ci).
export function polygonOutsideAreaRatio(poly, basePts, resolution=22){
  if(!basePts || basePts.length<3) return 0;
  const xs = poly.map(p=>p.x), zs = poly.map(p=>p.z);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minZ=Math.min(...zs), maxZ=Math.max(...zs);
  if(maxX-minX<1e-6 || maxZ-minZ<1e-6) return 0;
  let total=0, outside=0;
  for(let i=0;i<resolution;i++){
    for(let j=0;j<resolution;j++){
      const x = minX + (i+0.5)/resolution * (maxX-minX);
      const z = minZ + (j+0.5)/resolution * (maxZ-minZ);
      if(!pointInPolygon({x,z}, poly, 0)) continue;
      total++;
      if(!pointInPolygon({x,z}, basePts, 0)) outside++;
    }
  }
  return total>0 ? outside/total : 0;
}
// Si `poly` déborde de `basePts` de plus de `maxRatio`, le rétrécit
// progressivement vers son propre centre (recherche dichotomique du plus
// grand facteur d'échelle qui respecte la contrainte) jusqu'à repasser sous
// la limite — plutôt que de rejeter purement et simplement le tracé.
export function shrinkPolygonToFitOverlap(poly, basePts, maxRatio){
  if(polygonOutsideAreaRatio(poly, basePts) <= maxRatio) return poly;
  const c = polygonCentroidXZ(poly);
  function scaled(s){ return poly.map(p=>({x:c.x+(p.x-c.x)*s, z:c.z+(p.z-c.z)*s})); }
  let lo=0, hi=1;
  for(let i=0;i<22;i++){
    const mid=(lo+hi)/2;
    if(polygonOutsideAreaRatio(scaled(mid), basePts) <= maxRatio) lo=mid; else hi=mid;
  }
  return scaled(lo);
}
// Rollback CIBLÉ d'un décroché qui dépasse la règle des 30% de débord max :
// contrairement à shrinkPolygonToFitOverlap (qui rétrécit TOUT le polygone
// vers son centre, donc recalcule la position de chaque sommet), on se
// contente ici de ramener le ou les sommets qui viennent d'être déplacés à
// leur position d'avant le geste — tous les autres sommets restent
// strictement inchangés. `movedEntries` est un tableau de {index, start:{x,z}}.
export function revertBandOverflowIfNeeded(pts, belowFootprint, movedEntries){
  if(polygonOutsideAreaRatio(pts, belowFootprint) <= 0.30) return { pts, reverted:false };
  movedEntries.forEach(({index, start})=>{
    if(pts[index] && start) pts[index] = { x:start.x, z:start.z };
  });
  return { pts, reverted:true };
}
export function rotatePointAround(p, pivot, angle){
  const dx = p.x-pivot.x, dz = p.z-pivot.z;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: pivot.x + dx*cos - dz*sin, z: pivot.z + dz*cos + dx*sin };
}
// Répare une emprise chargée depuis un ancien projet JSON (sauvegardé avant
// la validation de contour complet) qui peut contenir une arête sortant d'un
// renfoncement concave du polygone, même si chaque sommet pris isolément est
// valide. Retrace la forme sommet par sommet, comme un tracé manuel : chaque
// point est glissé vers le précédent si l'arête qu'il forme sort de la zone.
// Répare une emprise chargée depuis un ancien projet JSON (sauvegardé avant
// la réparation "hugging" par insertion de sommets) : utilise directement
// repairClosedPolygonAgainstZone, qui insère les sommets du polygone le long
// de tout renfoncement concave plutôt que de raccourcir grossièrement l'arête.
export function repairBuildingPoints(points, zone){
  if(!points || points.length<3 || zone.length<3) return points;
  return repairClosedPolygonAgainstZone(points, zone);
}
export function pointInBoxXZ(box, pos){
  if(!box || !pos) return false;
  return pos.x>=box.min.x && pos.x<=box.max.x && pos.z>=box.min.z && pos.z<=box.max.z;
}
