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
