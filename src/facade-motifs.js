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
//                         (skew négatif = incline vers la gauche, positif =
//                         vers la droite). Le décalage s'enroule
//                         horizontalement (périodique tous les MOTIF_PITCH_M) :
//                         un skew qui vaut UN MULTIPLE ENTIER de MOTIF_PITCH_M
//                         (ex. exactement 2.0 pour un pitch de 2 m) produit un
//                         motif "sans couture" qui se raccorde parfaitement
//                         d'un étage à l'autre — voir incline_droit/gauche.
//   - "arch"            : corps rectangulaire {w, h, sill} surmonté d'un
//                         demi-cercle de rayon w/2 → baie en arche. Avec
//                         h=null, le rayon du dôme est automatiquement
//                         déduit du budget disponible (sol→plafond−topMargin)
//                         pour que le SOMMET du dôme (pas juste le corps)
//                         affleure le plafond, pas au-delà.
//   - "grid"            : rectangle {w, h, sill} subdivisé en {cols}x{rows}
//                         petits carreaux séparés par des croisillons fins
//                         → fenêtre à petits bois / fenêtre double (avec
//                         éventuellement un montant central plus large via
//                         {centerGap}).
//   - "transom"         : rectangle {w, h, sill} coupé en deux horizontalement
//                         → un grand carreau en bas + un bandeau en haut
//                         (hauteur {transomHeight}) lui-même subdivisé en
//                         {transomRows} petites bandes → baie à imposte /
//                         baie à barreaudage.
//
// Propriétés de chaque motif :
//   label      texte affiché sur le bouton de sélection dans la fiche bâtiment
//   kind       "rect" | "parallelogram" | "arch" | "grid" | "transom"
//   w          largeur de la fenêtre (m)
//   h          hauteur de la fenêtre (m) — mettre `null` pour "sol → plafond"
//              (voir topMargin ci-dessous ; utilisé par toutes les "baies")
//   sill       hauteur de l'allège, c.-à-d. du sol jusqu'au bas de la
//              fenêtre (m) — mettre 0 pour une baie qui touche vraiment le sol
//   skew       (parallelogram uniquement) décalage horizontal du haut par
//              rapport au bas (m) — augmente = incline davantage, négatif
//              = incline dans l'autre sens ; voir note "sans couture" ci-dessus
//   topMargin  (optionnel, seulement si h=null) marge laissée entre le haut
//              de la fenêtre (dôme compris pour "arch") et le plafond de
//              l'étage (m)
//   cols, rows (grid uniquement) nombre de carreaux en largeur / hauteur
//   mullion    (grid uniquement) épaisseur d'un croisillon interne, en
//              fraction de la largeur d'un carreau (ex. 0.06 = 6%)
//   centerGap  (grid uniquement, optionnel, défaut 0) épaisseur ADDITIONNELLE
//              au montant vertical central — utile pour simuler deux
//              battants/fenêtres accolés plutôt qu'un simple petit-bois
//   transomHeight (transom uniquement) hauteur du bandeau supérieur subdivisé (m)
//   transomRows   (transom uniquement) nombre de petits carreaux dans ce
//              bandeau (donc transomRows-1 barreaux horizontaux internes,
//              plus la limite avec le grand carreau du bas)
//
// Pour AJOUTER un motif : copie une ligne existante, change la clé
// (ex. "grande_baie"), ajuste les valeurs, puis ajoute la même clé dans
// MOTIF_KIND_INDEX si tu inventes un nouveau "kind" (rare — les 5 formes
// ci-dessus couvrent déjà rect/incliné/arche/grille/imposte).
// Pour SUPPRIMER un motif : supprime simplement sa ligne (s'il est encore
// utilisé sur un bâtiment existant, ce bâtiment retombera sur DEFAULT_MOTIF).

// Largeur d'un motif/carreau de façade (m) — répété le long du mur.
export const MOTIF_PITCH_M = 2.0;

// Teinte de façade par défaut (blanc cassé), personnalisable par bloc dans
// la fiche bâtiment — ceci n'est que la valeur de repli.
export const DEFAULT_FACADE_TINT = '#ede8db';

// Motif utilisé par défaut pour un nouveau bloc / bâtiment. "portrait" a été
// supprimé (cf. ménage ci-dessous) : repli sur "pleine_hauteur", qui reste
// garanti d'exister.
export const DEFAULT_MOTIF = 'pleine_hauteur';

export const MOTIFS = {
  // Référence de hauteur pour toutes les "baies" ci-dessous (sol→plafond,
  // avec une petite allège de 0.15 m et 0.2 m de marge sous le plafond).
  pleine_hauteur:      { label:'Baie pleine hauteur',       kind:'rect',           w:1.5, h:null, sill:0.15, topMargin:0.2 },

  // Baie en arche allant jusqu'au sol, comme une porte cochère — même
  // recette de hauteur que "pleine_hauteur" (h=null réutilise sill/topMargin
  // identiques) ; le rayon du dôme (w/2) est automatiquement déduit du
  // budget de hauteur, voir motifParamsFor()/motifSvgPreview() dans index.html.
  arche:               { label:'Baie en arche',             kind:'arch',           w:1.2, h:null, sill:0.15, topMargin:0.2 },

  // Baie à imposte / baie à barreaudage : même hauteur "pleine_hauteur" que
  // ci-dessus, un grand vantail en bas + un petit bandeau vitré en haut.
  imposte_simple:      { label:'Baie à imposte',            kind:'transom',        w:0.9, h:null, sill:0.15, topMargin:0.2, transomHeight:0.35, transomRows:1 },
  imposte_multiple:    { label:'Baie à barreaudage',        kind:'transom',        w:1.0, h:null, sill:0.15, topMargin:0.2, transomHeight:0.45, transomRows:4 },

  // Fenêtres inclinées "sans couture" : sill=0 et h=null/topMargin=0 → la
  // fenêtre occupe TOUTE la hauteur d'étage (aucune zone de mur au-dessus/
  // en dessous), et skew = ±MOTIF_PITCH_M pile (un carreau entier) → grâce
  // à l'enroulement horizontal du motif, la diagonale se raccorde à
  // l'identique d'un étage au suivant, comme sur l'image de référence
  // fournie (bande diagonale carrelable à l'infini).
  incline_droit:       { label:'Fenêtre inclinée (droite)', kind:'parallelogram',  w:0.9, h:null, sill:0, topMargin:0, skew:MOTIF_PITCH_M },
  incline_gauche:      { label:'Fenêtre inclinée (gauche)', kind:'parallelogram',  w:0.9, h:null, sill:0, topMargin:0, skew:-MOTIF_PITCH_M },

  // --- Motifs additionnels conservés tels quels (non concernés par cette
  // dernière demande) ---
  etroite:             { label:'Fenêtre étroite',           kind:'rect',           w:0.7, h:1.9, sill:0.55 },
  double:              { label:'Fenêtre double',            kind:'grid',           w:1.8, h:1.3, sill:0.85, cols:2, rows:1, mullion:0.10 },
  grille:              { label:'Fenêtre à petits bois',     kind:'grid',           w:1.8, h:1.1, sill:0.95, cols:3, rows:2, mullion:0.06 },
  double_grille:       { label:'Double fenêtre à croisillons', kind:'grid',        w:1.9, h:1.5, sill:0.75, cols:4, rows:3, mullion:0.05, centerGap:0.10 }
};

// Table de correspondance "kind" (texte) → index numérique, utilisée côté
// shader GLSL (un uniform float est plus simple à passer qu'une string).
// À compléter uniquement si tu ajoutes un nouveau "kind" dans MOTIFS
// ci-dessus (et son implémentation dans buildGlassWindowGLSL, index.html).
export const MOTIF_KIND_INDEX = { rect:0, parallelogram:1, arch:2, grid:3, transom:4 };
