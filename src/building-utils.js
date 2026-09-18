// Fonctions PURES de calcul sur un bâtiment (aucune dépendance à l'état de
// l'application — prennent le bâtiment `b` en paramètre). Extrait d'index.html.

import { polygonAreaXZ } from './geometry-utils.js';
import { FLOOR_HEIGHT, FLOOR_HEIGHTS, DEFAULT_USAGE } from './config.js';

export function floorHeightFor(usage){ return FLOOR_HEIGHTS[usage] || FLOOR_HEIGHT; }

export function footprintForBand(b, band){
  return (band && band.points && band.points.length>=3) ? band.points : b.points;
}

export function usageAtFloor(b, floor){
  const band = b.bands.find(bd=>floor>=bd.from && floor<=bd.to);
  return band ? band.usage : DEFAULT_USAGE;
}

export function buildingTotalHeight(b){
  let h = 0;
  for(let f=1; f<=b.floors; f++) h += floorHeightFor(usageAtFloor(b, f));
  return h;
}

// Surface potentielle totale = somme, PAR TRANCHE, de la surface de son
// propre contour (celui du socle, sauf décroché avec un contour plus petit)
// × son nombre d'étages — plus une simple emprise unique × nb d'étages, pour
// rester exact dès qu'une tranche a un contour différent du socle.
export function buildingTotalFloorArea(b){
  return b.bands.reduce((sum, band)=>{
    const nFloors = Math.max(0, band.to - band.from + 1);
    return sum + polygonAreaXZ(footprintForBand(b, band)) * nFloors;
  }, 0);
}
