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
//                         (skew négatif = incline vers la gauche, positif = vers la droite)
//   - "arch"            : corps rectangulaire {w, h, sill} surmonté d'un
//                         demi-cercle de rayon w/2 → baie en arche
//   - "grid"            : rectangle {w, h, sill} subdivisé en {cols}x{rows}
//                         petits carreaux séparés par des croisillons fins
//                         → fenêtre à petits bois / fenêtre double (avec
//                         éventuellement un montant central plus large via
//                         {centerGap}). NOUVEAU — implémentation GLSL à
//                         ajouter dans index.html (voir bloc en bas de fichier).
//   - "transom"         : rectangle {w, h, sill} coupé en deux horizontalement
//                         → un grand carreau en bas + un bandeau en haut
//                         (hauteur {transomHeight}) lui-même subdivisé en
//                         {transomRows} petites bandes → imposte / soubassement
//                         à barreaudage. NOUVEAU — implémentation GLSL à
//                         ajouter dans index.html (voir bloc en bas de fichier).
//
// Propriétés de chaque motif :
//   label      texte affiché sur le bouton de sélection dans la fiche bâtiment
//   kind       "rect" | "parallelogram" | "arch" | "grid" | "transom"
//   w          largeur de la fenêtre (m)
//   h          hauteur de la fenêtre (m) — mettre `null` pour "sol → plafond"
//              (voir topMargin ci-dessous ; utilisé par "pleine_hauteur")
//   sill       hauteur de l'allège, c.-à-d. du sol jusqu'au bas de la
//              fenêtre (m)
//   skew       (parallelogram uniquement) décalage horizontal du haut par
//              rapport au bas (m) — augmente = incline davantage, négatif
//              = incline dans l'autre sens
//   topMargin  (optionnel, seulement si h=null) marge laissée entre le haut
//              de la fenêtre et le plafond de l'étage (m)
//   cols, rows (grid uniquement) nombre de carreaux en largeur / hauteur
//   mullion    (grid uniquement) épaisseur d'un croisillon interne, en
//              fraction de la largeur d'un carreau (ex. 0.06 = 6%)
//   centerGap  (grid uniquement, optionnel, défaut 0) épaisseur ADDITIONNELLE
//              au montant vertical central — utile pour simuler deux
//              battants/fenêtres accolés plutôt qu'un simple petit-bois
//   transomHeight (transom uniquement) hauteur du bandeau supérieur subdivisé (m)
//   transomRows   (transom uniquement) nombre de petits carreaux dans ce
//              bandeau (donc transomRows-1 barreaux horizontaux)
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

// Motif utilisé par défaut pour un nouveau bloc / bâtiment.
export const DEFAULT_MOTIF = 'portrait';

export const MOTIFS = {
  carre:               { label:'Carré',                  kind:'rect',           w:1.2, h:1.2, sill:0.9 },
  carre_incline:       { label:'Carré incliné',           kind:'parallelogram',  w:1.2, h:1.2, sill:0.9, skew:0.35 },
  portrait:            { label:'Rectangle portrait',      kind:'rect',           w:0.9, h:2.0, sill:0.6 },
  etroite:             { label:'Fenêtre étroite',         kind:'rect',           w:0.7, h:1.9, sill:0.55 },
  paysage:             { label:'Rectangle paysage',       kind:'rect',           w:1.6, h:0.9, sill:1.05 },
  paysage_incline:     { label:'Paysage incliné',         kind:'parallelogram',  w:1.6, h:0.9, sill:1.05, skew:0.35 },
  // arche recalibrée : dôme (rayon = w/2) proche de la moitié de la hauteur totale,
  // pour un vrai arc plutôt qu'un simple chapeau sur un long rectangle
  arche:               { label:'Baie en arche',           kind:'arch',           w:1.2, h:0.9, sill:0.7 },
  pleine_hauteur:      { label:'Baie pleine hauteur',      kind:'rect',           w:1.5, h:null, sill:0.15, topMargin:0.2 }, // h calculé (sol→plafond)

  // --- Fenêtres à petits carreaux / doubles (nouveau kind "grid") ---
  double:              { label:'Fenêtre double',          kind:'grid',           w:1.8, h:1.3, sill:0.85, cols:2, rows:1, mullion:0.10 },
  grille:              { label:'Fenêtre à petits bois',   kind:'grid',           w:1.8, h:1.1, sill:0.95, cols:3, rows:2, mullion:0.06 },
  double_grille:       { label:'Double fenêtre à croisillons', kind:'grid',      w:1.9, h:1.5, sill:0.75, cols:4, rows:3, mullion:0.05, centerGap:0.10 },

  // --- Fenêtres à imposte / bandeau barreaudé en partie haute (nouveau kind "transom") ---
  imposte_simple:      { label:'Fenêtre à imposte',       kind:'transom',        w:0.8, h:1.7, sill:0.6, transomHeight:0.35, transomRows:1 },
  imposte_multiple:    { label:'Petite fenêtre à barreaudage', kind:'transom',   w:1.0, h:1.3, sill:0.75, transomHeight:0.4, transomRows:4 },

  // --- Variantes inclinées à droite/gauche (parallelogram, skew signé) ---
  incline_droit:       { label:'Fenêtre inclinée (droite)', kind:'parallelogram', w:0.7, h:2.0, sill:0.5, skew:0.6 },
  incline_gauche:      { label:'Fenêtre inclinée (gauche)', kind:'parallelogram', w:0.7, h:2.0, sill:0.5, skew:-0.6 }
};

// Table de correspondance "kind" (texte) → index numérique, utilisée côté
// shader GLSL (un uniform float est plus simple à passer qu'une string).
// À compléter uniquement si tu ajoutes un nouveau "kind" dans MOTIFS
// ci-dessus (et son implémentation dans buildGlassWindowGLSL, index.html).
export const MOTIF_KIND_INDEX = { rect:0, parallelogram:1, arch:2, grid:3, transom:4 };

// ============================================================
// ⚠️ À FAIRE DANS index.html — implémentation GLSL des kinds
//    "grid" et "transom" (kind index 3 et 4 ci-dessus)
// ============================================================
// Je n'ai pas le contenu de buildGlassWindowGLSL()/motifParamsFor() dans
// index.html, donc je ne peux pas câbler ça précisément à ta convention de
// variables actuelle (noms d'uniforms, espace de coordonnées, etc.).
// Voici le principe à transposer avec les mêmes conventions que "rect" :
//
// kind = 3 "grid" — à l'intérieur du rectangle de fenêtre [xMin,xMax]x[yMin,yMax] :
//   float lx = (uvx - xMin) / (xMax - xMin) * float(cols);
//   float ly = (uvy - yMin) / (yMax - yMin) * float(rows);
//   float fx = fract(lx), fy = fract(ly);
//   float onMullion = step(fx, mullion*0.5) + step(1.0-mullion*0.5, fx)
//                    + step(fy, mullion*0.5) + step(1.0-mullion*0.5, fy);
//   // montant central plus large (centerGap), colonne du milieu uniquement :
//   float colCenter = abs(floor(lx) + 0.5 - float(cols)*0.5);
//   float onCenterGap = step(colCenter, 0.001) * step(abs(fx-0.5), centerGap*0.5);
//   float isGlass = 1.0 - clamp(onMullion + onCenterGap, 0.0, 1.0);
//
// kind = 4 "transom" — dans le même rectangle de fenêtre :
//   float transomStartFrac = 1.0 - (transomHeight / (yMax - yMin));
//   float ly = (uvy - yMin) / (yMax - yMin);
//   si ly < transomStartFrac  → grand carreau plein (comme "rect")
//   sinon (dans le bandeau)   → réappliquer la logique "grid" ci-dessus avec
//                               cols=1, rows=transomRows, sur la seule
//                               tranche [transomStartFrac, 1] de ly
//
// Une fois que tu me passes buildGlassWindowGLSL() (et motifParamsFor()), je
// peux écrire directement le code GLSL final avec tes vrais noms de variables.
