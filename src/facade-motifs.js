// ============================================================
// MOTIFS DE FENÊTRES DE FAÇADE — fichier à éditer librement
// ============================================================
// C'est ICI que tu modifies la forme des fenêtres des nouveaux bâtiments
// (résidentiel/bureaux/services/hôtel/non défini). Les commerces ont leur
// propre logique de grandes baies (COMMERCE_* dans index.html) et ne sont
// pas concernés par ce fichier.
//
// Chaque motif est un "carreau" de MOTIF_PITCH_M de large, répété tout du
// long du mur, à chaque étage. Toutes les dimensions sont en MÈTRES RÉELS
// (pas des fractions) — un motif "carré" (w=h) donne donc un vrai carré à
// l'écran, quelle que soit la hauteur d'étage du bloc concerné. La
// conversion en fractions de cellule pour le shader se fait ailleurs
// (motifParamsFor(), dans index.html) : tu n'as jamais besoin d'y toucher.
//
// Formes disponibles (propriété "kind") :
//   - "rect"           : fenêtre rectangulaire droite {w, h, sill}
//   - "parallelogram"   : comme rect, mais le haut est décalé horizontalement
//                         par rapport au bas de {skew} m → fenêtre "inclinée"
//   - "arch"            : corps rectangulaire {w, h, sill} surmonté d'un
//                         demi-cercle de rayon w/2 → baie en arche
//
// Propriétés de chaque motif :
//   label      texte affiché sur le bouton de sélection dans la fiche bâtiment
//   kind       "rect" | "parallelogram" | "arch"
//   w          largeur de la fenêtre (m)
//   h          hauteur de la fenêtre (m) — mettre `null` pour "sol → plafond"
//              (voir topMargin ci-dessous ; utilisé par "pleine_hauteur")
//   sill       hauteur de l'allège, c.-à-d. du sol jusqu'au bas de la
//              fenêtre (m)
//   skew       (parallelogram uniquement) décalage horizontal du haut par
//              rapport au bas (m) — augmente = incline davantage
//   topMargin  (optionnel, seulement si h=null) marge laissée entre le haut
//              de la fenêtre et le plafond de l'étage (m)
//
// Pour AJOUTER un motif : copie une ligne existante, change la clé
// (ex. "grande_baie"), ajuste les valeurs, puis ajoute la même clé dans
// MOTIF_KIND_INDEX si tu inventes un nouveau "kind" (rare — les 3 formes
// ci-dessus couvrent déjà rect/incliné/arche).
// Pour SUPPRIMER un motif : supprime simplement sa ligne (s'il est encore
// utilisé sur un bâtiment existant, ce bâtiment retombera sur DEFAULT_MOTIF).

// Largeur d'un motif/carreau de façade (m) — répété le long du mur.
export const MOTIF_PITCH_M = 2.0;

// Teinte de façade par défaut (blanc cassé), personnalisable par bloc dans
// la fiche bâtiment — ceci n'est que la valeur de repli.
export const DEFAULT_FACADE_TINT = '#ede8db';

// Motif utilisé par défaut pour un nouveau bloc / bâtiment.
export const DEFAULT_MOTIF = 'portrait';

export const MOTIFS = {
  carre:            { label:'Carré',                kind:'rect',           w:1.2, h:1.2, sill:0.9 },
  carre_incline:    { label:'Carré incliné',         kind:'parallelogram',  w:1.2, h:1.2, sill:0.9, skew:0.35 },
  portrait:         { label:'Rectangle portrait',    kind:'rect',           w:0.9, h:2.0, sill:0.6 },
  paysage:          { label:'Rectangle paysage',     kind:'rect',           w:1.6, h:0.9, sill:1.05 },
  paysage_incline:  { label:'Paysage incliné',       kind:'parallelogram',  w:1.6, h:0.9, sill:1.05, skew:0.35 },
  arche:            { label:'Baie en arche',         kind:'arch',           w:1.1, h:1.55, sill:0.7 },
  pleine_hauteur:   { label:'Baie pleine hauteur',   kind:'rect',           w:1.5, h:null, sill:0.15, topMargin:0.2 } // h calculé (sol→plafond)
};

// Table de correspondance "kind" (texte) → index numérique, utilisée côté
// shader GLSL (un uniform float est plus simple à passer qu'une string).
// À compléter uniquement si tu ajoutes un nouveau "kind" dans MOTIFS
// ci-dessus (et son implémentation dans buildGlassWindowGLSL, index.html).
export const MOTIF_KIND_INDEX = { rect:0, parallelogram:1, arch:2 };
