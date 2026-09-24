// Utilitaires PURS de parcours de scène THREE.js (aucune dépendance à l'état
// de l'application — prennent la racine à parcourir en paramètre). Extrait
// d'index.html.

// Premier objet dont le nom correspond exactement (insensible à la casse).
export function findByNameCI(root, name){
  const target = name.toLowerCase();
  let found = null;
  root.traverse(o=>{ if(!found && o.name && o.name.toLowerCase()===target) found = o; });
  return found;
}
// Certains ajouts dans Blender se retrouvent comme un DEUXIÈME objet distinct
// (ex. "Polygone_Implantation.001") plutôt que fusionnés dans le même mesh —
// on récupère donc TOUTES les pièces dont le nom commence par ce préfixe, pas
// juste la première trouvée.
export function findAllByNameCI(root, namePrefix){
  const target = namePrefix.toLowerCase();
  const found = [];
  root.traverse(o=>{ if(o.isMesh && o.name && o.name.toLowerCase().startsWith(target)) found.push(o); });
  return found;
}
// Parcours qui SAUTE les sous-arbres marqués `userData.excludeFromFraming`
// (ex. bâti de contexte "Bâtis 3D 2018", un disque de 3 km autour du site) :
// ils sont affichés, mais ne doivent peser ni dans les cadrages automatiques
// (Vue Globale, Skyline) ni dans les silhouettes techniques.
export function traverseFramed(root, fn){
  if(!root || (root.userData && root.userData.excludeFromFraming)) return;
  fn(root);
  root.children.forEach(c=> traverseFramed(c, fn));
}
// Équivalent de `new THREE.Box3().setFromObject(root)` qui ignore ces sous-arbres.
export function framingBox(THREE, root){
  const box = new THREE.Box3(), part = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  traverseFramed(root, o=>{
    const g = o.geometry;
    if(!g || !g.attributes || !g.attributes.position) return;
    if(!g.boundingBox) g.computeBoundingBox();
    box.union(part.copy(g.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return box;
}
