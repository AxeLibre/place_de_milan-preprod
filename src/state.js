// État partagé de l'application, exposé aux modules ES extraits d'index.html
// (extension-gare.js, camera-skyline.js, camera-architect.js, ...).
//
// index.html reste le seul endroit qui CRÉE ces objets (l'ordre d'init est
// délicat : scene → renderer → controls → worldRoot → chargement du site...),
// mais il les ENREGISTRE ici juste après création (et à chaque réaffectation)
// via les setters ci-dessous. Un module qui importe une valeur exportée
// (`import { scene } from './state.js'`) en obtient une liaison LIVE : elle
// se met à jour automatiquement dès qu'index.html appelle le setter
// correspondant — c'est le mécanisme standard des modules ES, qui évite de
// dupliquer la logique d'initialisation existante ou d'en changer l'ordre.
//
// Pas de logique ici : uniquement des variables + setters. Le comportement
// de l'application ne doit pas changer — seul l'endroit où vit chaque valeur
// est partagé plus largement.

export let scene = null;
export let camera = null;
export let controls = null;
export let renderer = null;
export let orthoCamera = null;
export let worldRoot = null;
export let siteRoot = null;
export let globalRoot = null;

export let buildZone = [];
export let buildings = [];
export let idCounter = 1;
export let selectedId = null;

export let planViewActive = false;
export let editingBuildingId = null;

export let hallMesh = null;
export let extensionGareMesh = null;
export let hallFacadeWorldNormal = null;

export let drawing = false;
export let drawMenuOpen = false;
export let treePlacing = false;
export let grassPainting = false;
export let labelPlacing = false;

export function setScene(v){ scene = v; }
export function setCamera(v){ camera = v; }
export function setControls(v){ controls = v; }
export function setRenderer(v){ renderer = v; }
export function setOrthoCamera(v){ orthoCamera = v; }
export function setWorldRoot(v){ worldRoot = v; }
export function setSiteRoot(v){ siteRoot = v; }
export function setGlobalRoot(v){ globalRoot = v; }

export function setBuildZone(v){ buildZone = v; }
export function setBuildings(v){ buildings = v; }
export function setIdCounter(v){ idCounter = v; }
// Compteur d'identifiants partagé (bâtiments ET tranches "Extension Gare",
// espaces de noms disjoints — les secondes sont préfixées "ext"). Un module
// qui a besoin d'un nouvel id appelle nextId() plutôt que d'incrémenter
// idCounter lui-même (un import ES est en lecture seule pour l'importeur).
export function nextId(){ return idCounter++; }
export function resetIdCounter(){ idCounter = 1; }
export function setSelectedId(v){ selectedId = v; }

export function setPlanViewActive(v){ planViewActive = v; }
export function setEditingBuildingId(v){ editingBuildingId = v; }

export function setHallMesh(v){ hallMesh = v; }
export function setExtensionGareMesh(v){ extensionGareMesh = v; }
export function setHallFacadeWorldNormal(v){ hallFacadeWorldNormal = v; }

export function setDrawing(v){ drawing = v; }
export function setDrawMenuOpen(v){ drawMenuOpen = v; }
export function setTreePlacing(v){ treePlacing = v; }
export function setGrassPainting(v){ grassPainting = v; }
export function setLabelPlacing(v){ labelPlacing = v; }
