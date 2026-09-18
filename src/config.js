// Constantes de configuration partagées (couleurs, etc.), sans dépendance à
// l'état de l'application — extrait d'index.html.

export const NEON_BLUE = 0x2ee8ff;

export const FLOOR_HEIGHT = 3.0; // metres — fallback générique
// Hauteur d'étage réelle selon l'usage (mètres) : résidentiel 3m, hôtel 3.5m,
// bureaux/commerces/services 4m — utilisée pour empiler les tranches à leur
// vraie hauteur plutôt qu'une hauteur unique.
export const FLOOR_HEIGHTS = {
  residentiel: 3.0,
  hotel:       3.5,
  bureaux:     4.0,
  commerces:   4.0,
  services:    4.0
};
export const USAGE_COLORS = {
  residentiel: 0xe0a24a,
  bureaux:     0x5b8ab0,
  commerces:   0xd95a6c,
  hotel:       0xa06bd9,
  services:    0x4fae8f,
  nondefini:   0x9aa0a6
};
export const USAGE_LABELS = {
  residentiel: "Résidentiel",
  bureaux: "Bureaux",
  commerces: "Commerces",
  hotel: "Hôtel",
  services: "Services",
  nondefini: "Non défini"
};
export const DEFAULT_USAGE = 'nondefini'; // usage par défaut de tout nouveau bâtiment/volume
