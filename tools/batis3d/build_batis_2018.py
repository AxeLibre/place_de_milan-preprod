# -*- coding: utf-8 -*-
"""
build_batis_2018.py — génère batis_2018.glb (bâti 3D 2018 de la Métropole de Lyon)
===================================================================================
Complète la maquette de la page (place_de_milan.glb + global.glb) avec le
jeu de données « Bâtis 3D 2018 de la Métropole de Lyon » (Licence Ouverte
Etalab 2.0) :
    https://data.grandlyon.com/portail/fr/jeux-de-donnees/batis-3d-2018-de-la-metropole-de-lyon/info

Ce jeu est composé de deux couches, téléchargées ici via le service WFS de
data.grandlyon.com, uniquement dans un disque de RADIUS mètres autour de la
place :
  - « Volumes de toiture 3D 2018 » : emprise de chaque pan de bâti au niveau
    de la gouttière + zmini/zmaxi (altitudes NGF du toit), hfacade, htotale,
    type de toit (plan / non plan) ;
  - « Lignes de faîtage 3D 2018 » : arêtes de toiture.

POURQUOI UN COMPLÉMENT ET PAS UN REMPLACEMENT
---------------------------------------------
Les Bâtis 3D ne contiennent QUE des volumes bâtis : ni sol, ni voirie, ni
rails, ni gare, ni lumières, ni objets nommés (Polygone_Implantation,
Hall_Gare, Route_*, Detector_*...) dont dépend toute la logique de la page.
Ils datent en outre de 2018 (Part-Dieu en plein chantier : To-Lyon, gare...),
alors que la maquette Blender est à jour. On garde donc la maquette actuelle
là où elle existe, et on ajoute les Bâtis 3D tout AUTOUR :

  1. un bâtiment Bâtis 3D est retiré s'il touche le polygone d'implantation
     (objet "polygone_implantation" de place_de_milan.glb) ;
  2. il est aussi retiré s'il tombe dans l'emprise au sol des maquettes
     existantes (place_de_milan.glb + global.glb, rasterisées puis
     vectorisées) ou chevauche un de leurs bâtiments ;
  3. un sol plat (matériau "TROTTOIRE") est ajouté sous les Bâtis, troué à
     l'emprise des maquettes existantes (il passe 2 m dessous, sans jamais
     les recouvrir).

GÉOMÉTRIE
---------
  - murs : extrudés du sol jusqu'à la gouttière (zmini) ; un mur mitoyen
    masqué par un voisin au moins aussi haut n'est pas généré ;
  - toits plats : à zmini ;
  - toits non plans : bords à zmini, lignes de faîtage à zmaxi ; le volume
    est découpé en pans le long des faîtages (prolongés jusqu'à la façade
    pour les croupes, pignons quand un faîtage touche la façade), chaque pan
    étant triangulé par Delaunay contraint ; sans faîtage connu, toit en
    croupe sur le grand axe du bâtiment (voir _pitched_roof) ;
  - matériaux nommés comme ceux de global.glb ("BATIMENTS_fenetre" pour les
    façades, "TROTTOIRE" pour le sol) : la page leur applique automatiquement
    le même rendu (fenêtres allumées la nuit, dégradé de façade, éclairage
    simplifié du sol, brouillard...). Les toits ("BATIS_TOIT", même teinte que
    "BATIMENTS") n'ont pas de normales : ombrage à facettes calculé par
    Three.js, pour un fichier bien plus léger.

GÉORÉFÉRENCEMENT : voir georef.json (produit par calibrate_batis_2018.py).

USAGE (depuis la racine du site, là où se trouve index.html) :
    python tools/batis3d/build_batis_2018.py            # utilise le cache
    python tools/batis3d/build_batis_2018.py --refresh  # re-télécharge
Produit : batis_2018.glb (à côté d'index.html) et tools/batis3d/_cache/apercu.png
(contrôle visuel des exclusions). À relancer après toute modification du
polygone d'implantation ou de l'emprise de place_de_milan.glb / global.glb.
Le dossier _cache/ n'a pas besoin d'être mis en ligne.

Dépendances : numpy, shapely>=2.1, pyproj, mapbox_earcut, pillow (aperçu).
    python -m pip install numpy shapely pyproj mapbox_earcut pillow
"""
import argparse
import shutil
import subprocess
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import polylabel

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from glb_io import read_triangles, write_glb  # noqa: E402

SITE_DIR = os.path.normpath(os.path.join(HERE, '..', '..'))
CACHE_DIR = os.path.join(HERE, '_cache')
GEOREF_PATH = os.path.join(HERE, 'georef.json')
OUT_PATH = os.path.join(SITE_DIR, 'batis_2018.glb')

CENTER_LATLON = [45.76211179556013, 4.858197572028974]  # centre de la place / des .glb
RADIUS = 1500.0            # m — rayon du disque de Bâtis 3D autour de la place
GROUND_MARGIN = 150.0      # m — le sol dépasse un peu le dernier bâtiment (fondu dans le brouillard)
TILE_SIZE = 500.0          # m — découpage en tuiles (culling par tuile côté Three.js)

WFS_URL = 'https://data.grandlyon.com/geoserver/metropole-de-lyon/ows'
LAYER_TOITS = 'metropole-de-lyon:fpc_fond_plan_communaut.fpctoit_2018'
LAYER_FAITAGES = 'metropole-de-lyon:fpc_fond_plan_communaut.fpclignefaitage_2018'

# Exclusion par les maquettes existantes
MASK_RES = 2.0             # m — résolution de la rasterisation de leur emprise
MASK_MAX_FRACTION = 0.15   # un Bâtis est retiré dès que 15 % de son emprise est dans la maquette existante
IGNORED_NODES = ('route_', 'detector', 'sph', 'light', 'point', 'global_light', 'cube.005')

# Filtrage des micro-volumes (abris, édicules) sans intérêt à cette échelle
MIN_AREA = 4.0             # m²
MIN_HEIGHT = 2.5           # m

MATERIALS = {
    # mêmes noms (et mêmes couleurs de base) que dans global.glb
    'BATIMENTS_fenetre': {'color': (0.3632, 0.3632, 0.3632), 'metallic': 0.278, 'roughness': 0.255},
    'BATIS_TOIT': {'color': (0.3632, 0.3632, 0.3632), 'metallic': 0.278, 'roughness': 0.255},  # = BATIMENTS, sans normales
    'TROTTOIRE': {'color': (0.1155, 0.1189, 0.1147), 'metallic': 0.0, 'roughness': 0.5},
}


# ======================================================================
# Téléchargement (WFS, avec cache local)
# ======================================================================
def lambert_center():
    from pyproj import Transformer
    t = Transformer.from_crs(4326, 3946, always_xy=True)
    e, n = t.transform(CENTER_LATLON[1], CENTER_LATLON[0])
    return float(e), float(n)


def fetch_layer(layer, radius, refresh=False):
    """Features GeoJSON (EPSG:3946) de `layer` dans le carré circonscrit au disque de rayon `radius`."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    short = layer.split('.')[-1]
    path = os.path.join(CACHE_DIR, f'{short}_r{int(radius)}.json')
    if os.path.exists(path) and not refresh:
        return json.load(open(path, encoding='utf-8'))
    e0, n0 = lambert_center()
    bbox = f'{e0 - radius},{n0 - radius},{e0 + radius},{n0 + radius},urn:ogc:def:crs:EPSG::3946'
    feats, start, page = [], 0, 5000
    while True:
        q = urllib.parse.urlencode({
            'SERVICE': 'WFS', 'VERSION': '2.0.0', 'REQUEST': 'GetFeature', 'TYPENAMES': layer,
            'OUTPUTFORMAT': 'application/json', 'SRSNAME': 'EPSG:3946', 'SORTBY': 'gid',
            'COUNT': page, 'STARTINDEX': start, 'BBOX': bbox})
        for attempt in range(4):
            try:
                d = json.load(urllib.request.urlopen(f'{WFS_URL}?{q}', timeout=300))
                break
            except Exception as err:  # réseau capricieux : on réessaie
                if attempt == 3:
                    raise
                print('  nouvel essai après erreur :', err)
                time.sleep(3)
        feats += d['features']
        print(f'  {short} : {len(feats)} objets')
        if len(d['features']) < page:
            break
        start += page
    json.dump(feats, open(path, 'w', encoding='utf-8'))
    return feats


# ======================================================================
# Géoréférencement Lambert CC46 -> repère glTF de la maquette
# ======================================================================
class Georef:
    def __init__(self, path=GEOREF_PATH):
        g = json.load(open(path, encoding='utf-8'))
        self.e0, self.n0 = g['E0'], g['N0']
        self.s = g['scale']
        self.a = g['scale'] * complex(math.cos(math.radians(g['rotation_deg'])), math.sin(math.radians(g['rotation_deg'])))
        self.b = complex(g['tx'], g['tz'])
        self.z_ref, self.y_off = g['z_ref'], g.get('y_offset', 0.0)

    def xz(self, en):
        en = np.asarray(en, float)
        q = self.a * ((en[:, 0] - self.e0) - 1j * (en[:, 1] - self.n0)) + self.b
        return np.c_[q.real, q.imag]

    def y(self, alt):
        return self.s * (alt - self.z_ref) + self.y_off


# ======================================================================
# Emprise des maquettes existantes
# ======================================================================
def _raster_triangles(tris_xz, x0, z0, nx, nz, res):
    img = np.zeros((nz, nx), bool)
    gx = x0 + (np.arange(nx) + .5) * res
    gz = z0 + (np.arange(nz) + .5) * res
    for a, b, c in tris_xz:
        lo = np.floor((np.minimum(np.minimum(a, b), c) - [x0, z0]) / res).astype(int)
        hi = np.ceil((np.maximum(np.maximum(a, b), c) - [x0, z0]) / res).astype(int) + 1
        lo, hi = np.clip(lo, 0, [nx, nz]), np.clip(hi, 0, [nx, nz])
        if hi[0] <= lo[0] or hi[1] <= lo[1]:
            continue
        px, pz = np.meshgrid(gx[lo[0]:hi[0]], gz[lo[1]:hi[1]])
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-9:
            continue
        l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[1])) / d
        l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[1])) / d
        tol = -res / max(1e-6, np.linalg.norm(b - a) + np.linalg.norm(c - b) + np.linalg.norm(a - c)) * 2
        img[lo[1]:hi[1], lo[0]:hi[0]] |= (l1 >= tol) & (l2 >= tol) & (l1 + l2 <= 1 - tol)
    return img


def _dilate(img, k):
    out = img.copy()
    for _ in range(k):
        o = out.copy()
        o[1:] |= out[:-1]; o[:-1] |= out[1:]; o[:, 1:] |= out[:, :-1]; o[:, :-1] |= out[:, 1:]
        out = o
    return out


def _erode(img, k):
    return ~_dilate(~img, k)


def _fill_holes(img):
    """Remplit les trous (zones non couvertes non reliées au bord)."""
    outside = np.zeros_like(img)
    outside[0, :] = ~img[0, :]; outside[-1, :] = ~img[-1, :]
    outside[:, 0] = ~img[:, 0]; outside[:, -1] = ~img[:, -1]
    free = ~img
    while True:
        grown = _dilate(outside, 1) & free
        if (grown == outside).all():
            break
        outside = grown
    return ~outside


def _vectorize(img, x0, z0, res):
    """Masque raster -> (Multi)Polygon shapely (union des segments de lignes)."""
    boxes = []
    for r in range(img.shape[0]):
        row = img[r]
        if not row.any():
            continue
        d = np.diff(np.r_[0, row.astype(np.int8), 0])
        for s, e in zip(np.where(d == 1)[0], np.where(d == -1)[0]):
            boxes.append(shapely.box(x0 + s * res, z0 + r * res, x0 + e * res, z0 + (r + 1) * res))
    return shapely.union_all(boxes).simplify(res * 0.5)


def existing_model_footprint():
    """Emprise au sol des .glb actuels + emprise de leurs bâtiments + altitude de leur sol en bordure."""
    tris, bld, ground = [], [], []
    for fn in ('place_de_milan.glb', 'global.glb'):
        for name, mat, t in read_triangles(os.path.join(SITE_DIR, fn)):
            if name.lower().startswith(IGNORED_NODES):
                continue
            tris.append(t[:, :, [0, 2]])
            if mat in ('BATIMENTS', 'BATIMENTS_fenetre', 'glass', 'glass_fenetre', 'glass_nolight', 'aluminium',
                       'tolyon', 'pyramide', 'BU', 'ppy', 'glass_carre', 'Crayon'):
                bld.append(t[t[:, :, 1].max(1) > 3.0][:, :, [0, 2]])
            if mat in ('ROUTE', 'TROTTOIRE'):
                ground.append(t.mean(1))
    tris = np.concatenate(tris)
    pts = tris.reshape(-1, 2)
    x0, z0 = np.floor(pts.min(0) / MASK_RES) * MASK_RES - 20
    x1, z1 = np.ceil(pts.max(0) / MASK_RES) * MASK_RES + 20
    nx, nz = int((x1 - x0) / MASK_RES), int((z1 - z0) / MASK_RES)
    cover = _raster_triangles(tris, x0, z0, nx, nz, MASK_RES)
    cover = _fill_holes(_erode(_dilate(cover, 3), 3))       # fermeture morphologique + trous bouchés
    cover_poly = _vectorize(cover, x0, z0, MASK_RES)
    bld_img = _dilate(_raster_triangles(np.concatenate(bld), x0, z0, nx, nz, MASK_RES), 1)
    bld_poly = _vectorize(bld_img, x0, z0, MASK_RES)
    # Altitude du sol des maquettes le long de leur bord : le sol ajouté se cale
    # juste en dessous, pour ne jamais recouvrir leur propre sol.
    ground = np.concatenate(ground)
    border = cover_poly.boundary
    dist = shapely.distance(shapely.points(ground[:, 0], ground[:, 2]), border)
    near = ground[dist < 25, 1]
    ground_y = float(np.percentile(near if len(near) > 20 else ground[:, 1], 10)) - 0.15
    return cover_poly, bld_poly, ground_y


def implantation_polygon():
    polys = []
    for name, _mat, t in read_triangles(os.path.join(SITE_DIR, 'place_de_milan.glb')):
        if name.lower().startswith('polygone_implantation'):
            polys += [shapely.polygons(tri[:, [0, 2]]) for tri in t]
    return shapely.union_all([p for p in polys if p.area > 1e-6]).buffer(0.05)


# ======================================================================
# Géométrie : murs + toits
# ======================================================================
class MeshBuilder:
    def __init__(self):
        self.pos, self.nor, self.idx, self.n = [], [], [], 0

    def add(self, verts, normals, tris):
        """normals : (3,) commune, (N,3) par sommet, ou None (pas de normales : ombrage à facettes côté Three.js)."""
        verts = np.asarray(verts, float)
        self.pos.append(verts)
        if normals is not None:
            self.nor.append(np.broadcast_to(normals, verts.shape) if np.ndim(normals) == 1 else np.asarray(normals))
        self.idx.append(np.asarray(tris, np.int64) + self.n)
        self.n += len(verts)

    def arrays(self):
        if not self.pos:
            return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0, np.int64)
        nor = np.concatenate(self.nor).astype(float) if self.nor else None
        return np.concatenate(self.pos), nor, np.concatenate(self.idx).ravel()


def _earcut(rings2d):
    import mapbox_earcut as earcut
    verts = np.concatenate(rings2d).astype(np.float64)
    ends = np.cumsum([len(r) for r in rings2d]).astype(np.uint32)
    return earcut.triangulate_float64(verts, ends).reshape(-1, 3)


def _insert_on_ring(ring, heights, p, h, tol=0.6):
    """Insère le point p (hauteur h) sur l'arête la plus proche de l'anneau s'il en est à moins de tol m."""
    a, b = ring, np.roll(ring, -1, axis=0)
    ab = b - a
    t = np.clip(((p - a) * ab).sum(1) / np.maximum((ab * ab).sum(1), 1e-12), 0, 1)
    proj = a + ab * t[:, None]
    d = np.linalg.norm(proj - p, axis=1)
    i = int(np.argmin(d))
    if d[i] > tol:
        return ring, heights, False
    if t[i] < 1e-3 or np.linalg.norm(proj[i] - a[i]) < 0.05:
        heights[i] = max(heights[i], h)
    elif t[i] > 1 - 1e-3 or np.linalg.norm(proj[i] - b[i]) < 0.05:
        j = (i + 1) % len(ring)
        heights[j] = max(heights[j], h)
    else:
        ring = np.insert(ring, i + 1, proj[i], axis=0)
        heights = np.insert(heights, i + 1, h)
    return ring, heights, True


def _synthetic_ridge(poly):
    """Faîtage de toit en croupe déduit du rectangle englobant minimal (quand les données n'en ont pas)."""
    r = np.array(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    e1, e2 = r[1] - r[0], r[2] - r[1]
    if np.linalg.norm(e1) < np.linalg.norm(e2):
        e1, e2 = e2, e1
    L, W = np.linalg.norm(e1), np.linalg.norm(e2)
    c = r.mean(0)
    if L - W < 0.5:
        return []                                   # quasi carré : pavillon (sommet unique)
    d = e1 / L * (L - W) / 2
    ln = LineString([c - d, c + d]).intersection(poly)
    return [g for g in getattr(ln, 'geoms', [ln]) if g.geom_type == 'LineString' and g.length > 0.3]


def _extend_free_ends(ridges, poly):
    """
    Prolonge chaque extrémité "libre" d'un faîtage (ni sur la façade, ni reliée
    à un autre faîtage) dans son axe jusqu'au contour : c'est l'arêtier de la
    croupe, qui sert de ligne de découpe du toit en pans.
    """
    net = shapely.union_all(ridges)
    border = poly.boundary
    ext = []
    for ln in ridges:
        c = np.array(ln.coords)
        for end, prev in ((c[0], c[1]), (c[-1], c[-2])):
            pe = Point(end)
            if border.distance(pe) < 0.05:
                continue
            others = net.difference(ln.buffer(0.01))
            if not others.is_empty and others.distance(pe) < 0.3:
                continue
            d = end - prev
            d = d / max(np.linalg.norm(d), 1e-9)
            ray = LineString([end, end + d * 5000])
            hit = ray.intersection(border)
            pts = [np.array(g.coords[0]) for g in getattr(hit, 'geoms', [hit]) if not g.is_empty]
            if not pts:
                continue
            far = min(pts, key=lambda q: np.linalg.norm(q - end))
            seg = LineString([end, far])
            if poly.buffer(0.05).contains(seg):
                ext.append(seg)
    return ext


def _pitched_roof(poly, ext, ext_h, holes, ridges, gutter, top):
    """
    Toit en pente : le polygone est DÉCOUPÉ le long des faîtages (et de leurs
    prolongements jusqu'au contour pour les croupes), puis chaque pan est
    triangulé par Delaunay contraint. Les sommets situés sur un faîtage sont à
    zmaxi, tous les autres à la gouttière : on obtient des pans plans (deux
    pans, croupes, pignons, appentis...). Sans faîtage connu, un faîtage de
    croupe est synthétisé sur le grand axe du bâtiment.
    Renvoie (triangles[N,3,2], hauteurs[N,3], ext, ext_h) ou None si la
    découpe échoue (repli : earcut avec les faîtages en points de Steiner).
    """
    from shapely.ops import split
    if not ridges:
        ridges = _synthetic_ridge(poly)
    if not ridges:
        return None
    # pignons : extrémité de faîtage sur la façade -> sommet du contour à zmaxi
    snapped = []
    for ln in ridges:
        c = np.array(ln.coords)
        for k in (0, len(c) - 1):
            ext, ext_h, on_ring = _insert_on_ring(ext, ext_h, c[k], top)
            if on_ring:
                c[k] = np.array(poly.exterior.interpolate(poly.exterior.project(Point(c[k]))).coords[0])
        snapped.append(LineString(c))
    base = Polygon(ext, holes)
    if not base.is_valid:
        return None
    ridge_net = shapely.union_all(snapped)
    cutter = shapely.union_all(snapped + _extend_free_ends(snapped, base))
    try:
        pieces = split(base, cutter)
    except Exception:
        return None
    tris, hs = [], []
    for piece in pieces.geoms:
        if piece.area < 0.05:
            continue
        for t in shapely.constrained_delaunay_triangles(piece).geoms:
            c = np.array(t.exterior.coords)[:3]
            d = shapely.distance(shapely.points(c), ridge_net)
            tris.append(c)
            hs.append(np.where(d < 0.05, top, gutter))
    if not tris:
        return None
    return np.array(tris), np.array(hs), ext, ext_h


def _earcut_roof(poly, ext, ext_h, holes, ridges, gutter, top):
    """Repli : earcut, faîtages (ou pôle d'inaccessibilité) en points de Steiner à zmaxi."""
    pts = []
    for ln in ridges:
        c = np.array(ln.coords)
        for p0, p1 in zip(c[:-1], c[1:]):
            n = max(1, int(np.ceil(np.linalg.norm(p1 - p0) / 2.0)))
            pts += [p0 + (p1 - p0) * k / n for k in range(n + 1)]
    if not pts:
        lab = polylabel(poly, 0.2)
        pts = [np.array([lab.x, lab.y])]
    inner = poly.buffer(-0.15)
    steiner = []
    for p in pts:
        ext, ext_h, on_ring = _insert_on_ring(ext, ext_h, p, top)
        if not on_ring and inner.contains(Point(p)) and all(np.linalg.norm(p - q) > 0.3 for q in steiner):
            steiner.append(p)
    rings = [ext] + holes + [s[None, :] for s in steiner]
    heights = np.concatenate([ext_h] + [np.full(len(h), gutter) for h in holes] + [np.full(len(steiner), top)])
    tri = _earcut(rings)
    v2 = np.concatenate(rings)
    return v2[tri], heights[tri], ext, ext_h


def build_volume(poly, props, ridges, geo, base_y, walls_out, roofs_out, edge_tops, bid):
    """Ajoute murs + toit d'un volume de toiture (poly en coordonnées locales XZ)."""
    zmini, zmaxi = props.get('zmini'), props.get('zmaxi')
    if zmini is None and zmaxi is None:
        return
    zmini = zmini if zmini is not None else zmaxi
    zmaxi = zmaxi if zmaxi is not None else zmini
    gutter = geo.y(zmini)
    top = geo.y(max(zmaxi, zmini))
    flat = 'non' not in (props.get('type') or '').lower() or top - gutter < 0.4
    if gutter - base_y < 1.0:
        return
    poly = shapely.orient_polygons(poly)          # extérieur CCW, trous CW (dans le plan x,z)
    ext = np.array(poly.exterior.coords)[:-1]
    holes = [np.array(r.coords)[:-1] for r in poly.interiors]
    ext_h = np.full(len(ext), gutter)
    roof = None
    if flat:
        tri = _earcut([ext] + holes)
        v2 = np.concatenate([ext] + holes)
        roof = (v2[tri], np.full(tri.shape, gutter))
    else:
        roof = _pitched_roof(poly, ext.copy(), ext_h.copy(), holes, ridges, gutter, top)
        if roof is None:
            roof = _earcut_roof(poly, ext.copy(), ext_h.copy(), holes, ridges, gutter, top)
        tri2d, tri_h, ext, ext_h = roof
        roof = (tri2d, tri_h)

    # ---- toit : sommets partagés, sans normales (Three.js ombre à facettes —
    # flatShading — bien plus léger que des sommets dupliqués par facette)
    tri2d, tri_h = roof
    if len(tri2d):
        v3 = np.c_[tri2d[..., 0].ravel(), tri_h.ravel(), tri2d[..., 1].ravel()]
        key = np.round(v3 * 1000).astype(np.int64)
        uniq, inv = np.unique(key, axis=0, return_inverse=True)
        verts = np.zeros((len(uniq), 3))
        verts[inv.ravel()] = v3
        t = inv.reshape(-1, 3)
        n = np.cross(verts[t[:, 1]] - verts[t[:, 0]], verts[t[:, 2]] - verts[t[:, 0]])
        t[n[:, 1] < 0] = t[n[:, 1] < 0][:, ::-1]
        t = t[(np.linalg.norm(n, axis=1) > 1e-8) & (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])]
        roofs_out.add(verts, None, t)

    # ---- murs (arêtes mémorisées pour le test de mitoyenneté, voir emit_walls)
    for ring, rh in [(ext, ext_h)] + [(h, np.full(len(h), gutter)) for h in holes]:
        for i in range(len(ring)):
            j = (i + 1) % len(ring)
            walls_out.append((bid, ring[i], ring[j], rh[i], rh[j]))
            edge_tops[_ekey(ring[i], ring[j])].append((bid, rh[i], rh[j]))


def _ekey(a, b):
    return (round(a[0] * 20), round(a[1] * 20), round(b[0] * 20), round(b[1] * 20))


def emit_walls(walls, edge_tops, base_y, out_by_tile, tile_of):
    skipped = 0
    for bid, a, b, ha, hb in walls:
        # arête parcourue en sens inverse par un voisin au moins aussi haut : mur caché
        hidden = any(obid != bid and oha >= hb - 0.05 and ohb >= ha - 0.05
                     for obid, ohb, oha in edge_tops.get(_ekey(b, a), ()))
        if hidden:
            skipped += 1
            continue
        d = b - a
        L = np.hypot(*d)
        if L < 0.05:
            continue
        nrm = np.array([d[1] / L, 0.0, -d[0] / L])                  # normale extérieure (anneau CCW en x,z)
        v = np.array([[a[0], base_y, a[1]], [b[0], base_y, b[1]], [b[0], hb, b[1]], [a[0], ha, a[1]]])
        out_by_tile[tile_of[bid]]['BATIMENTS_fenetre'].add(v, nrm, [[0, 2, 1], [0, 3, 2]])
    return skipped


# ======================================================================
# Programme principal
# ======================================================================
def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--refresh', action='store_true', help='re-télécharge les données WFS')
    ap.add_argument('--radius', type=float, default=RADIUS)
    args = ap.parse_args()
    t0 = time.time()
    geo = Georef()

    print('Emprise des maquettes existantes...')
    cover_poly, bld_poly, ground_y = existing_model_footprint()
    impl = implantation_polygon()
    base_y = ground_y - 1.0
    print(f'  emprise {cover_poly.area / 1e4:.1f} ha · polygone d\'implantation {impl.area:.0f} m² · sol ajouté à y={ground_y:.2f}')

    print('Téléchargement / cache WFS...')
    toits = fetch_layer(LAYER_TOITS, args.radius, args.refresh)
    faits = fetch_layer(LAYER_FAITAGES, args.radius, args.refresh)

    # ---- volumes -> polygones locaux + filtres
    cover_prep, bld_prep, impl_prep = cover_poly, bld_poly, impl
    shapely.prepare(cover_prep); shapely.prepare(bld_prep); shapely.prepare(impl_prep)
    vols, stats = [], defaultdict(int)
    for f in toits:
        g, pr = f['geometry'], f['properties']
        parts = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        for rings in parts:
            loc = [geo.xz(np.array(r)[:, :2]) for r in rings]
            poly = Polygon(loc[0], loc[1:])
            if not poly.is_valid:
                poly = shapely.make_valid(poly)
                poly = max(getattr(poly, 'geoms', [poly]), key=lambda p: p.area if p.geom_type == 'Polygon' else 0)
                if poly.geom_type != 'Polygon':
                    stats['invalide'] += 1
                    continue
            c = poly.centroid
            if math.hypot(c.x, c.y) > args.radius:
                stats['hors disque'] += 1
                continue
            h = (pr.get('htotale') or pr.get('hfacade') or 0)
            if poly.area < MIN_AREA or h < MIN_HEIGHT:
                stats['trop petit'] += 1
                continue
            if impl_prep.intersects(poly) and impl.intersection(poly).area > 0.5:
                stats['polygone d\'implantation'] += 1
                continue
            if cover_prep.intersects(poly) and cover_poly.intersection(poly).area > MASK_MAX_FRACTION * poly.area:
                stats['emprise maquette actuelle'] += 1
                continue
            if bld_prep.intersects(poly) and bld_poly.intersection(poly).area > 0.5:
                stats['chevauche un bâtiment actuel'] += 1
                continue
            vols.append((poly, pr))
    print(f'  {len(vols)} volumes conservés · retirés : ' + ', '.join(f'{k} {v}' for k, v in stats.items()))

    # ---- faîtages -> volume le plus probable
    tree = shapely.STRtree([p for p, _ in vols])
    ridges = defaultdict(list)
    for f in faits:
        g = f['geometry']
        lines = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
        for c in lines:
            ln = LineString(geo.xz(np.array(c)[:, :2]))
            best, bl = None, 0.0
            for i in tree.query(ln, predicate='intersects'):
                L = vols[i][0].buffer(0.3).intersection(ln).length
                if L > bl:
                    best, bl = i, L
            if best is None or bl < 0.5:
                continue
            clipped = vols[best][0].buffer(0.3).intersection(ln)
            for part in getattr(clipped, 'geoms', [clipped]):
                if part.geom_type == 'LineString' and part.length > 0.3:
                    ridges[best].append(part)

    # ---- géométrie par tuile
    def tile_key(p):
        c = p.centroid
        return (math.floor(c.x / TILE_SIZE), math.floor(c.y / TILE_SIZE))
    tile_of = {i: tile_key(p) for i, (p, _) in enumerate(vols)}
    out_by_tile = defaultdict(lambda: defaultdict(MeshBuilder))
    walls, edge_tops = [], defaultdict(list)
    for i, (poly, pr) in enumerate(vols):
        build_volume(poly, pr, ridges.get(i, []), geo, base_y, walls, out_by_tile[tile_of[i]]['BATIS_TOIT'], edge_tops, i)
    skipped = emit_walls(walls, edge_tops, base_y, out_by_tile, tile_of)
    print(f'  {len(walls) - skipped} murs ({skipped} mitoyens masqués supprimés) · {sum(1 for r in ridges.values() if r)} toits à faîtage')

    # ---- sol : disque troué à l'emprise des maquettes existantes (2 m sous leur bord)
    disc = Point(0, 0).buffer(args.radius + GROUND_MARGIN, 64)
    sol = disc.difference(cover_poly.buffer(-2.0)).simplify(0.5)
    sol_tris = shapely.constrained_delaunay_triangles(sol)
    ground_mb = MeshBuilder()
    for tpoly in sol_tris.geoms:
        c = np.array(tpoly.exterior.coords)[:3]
        v = np.c_[c[:, 0], np.full(3, ground_y), c[:, 1]]
        if np.cross(v[1] - v[0], v[2] - v[0])[1] < 0:
            v = v[::-1]
        ground_mb.add(v, np.array([0.0, 1.0, 0.0]), [[0, 1, 2]])

    tiles = []
    for (tx, tz), mats in sorted(out_by_tile.items()):
        prims = {m: mb.arrays() for m, mb in mats.items() if mb.n}
        tiles.append({'name': f'Batis2018_{tx}_{tz}', 'center': ((tx + .5) * TILE_SIZE, 0.0, (tz + .5) * TILE_SIZE), 'prims': prims})
    tiles.append({'name': 'Batis2018_Sol', 'center': (0.0, ground_y, 0.0), 'prims': {'TROTTOIRE': ground_mb.arrays()}})
    nverts = sum(len(p[0]) for t in tiles for p in t['prims'].values())
    ntris = sum(len(p[2]) // 3 for t in tiles for p in t['prims'].values())
    raw_path = os.path.join(CACHE_DIR, 'batis_2018_brut.glb')
    # Avec Node.js, glTF Transform quantifie + compresse lui-même (il faut lui
    # donner des float32) ; sans, on quantifie ici (KHR_mesh_quantization).
    can_compress = shutil.which('npx') is not None
    write_glb(raw_path, tiles, MATERIALS, quantize=not can_compress, extras={
        'source': 'Bâtis 3D 2018 de la Métropole de Lyon — data.grandlyon.com — Licence Ouverte Etalab 2.0',
        'radius_m': args.radius, 'ground_y': ground_y, 'volumes': len(vols)})
    if can_compress:
        compress_meshopt(raw_path, OUT_PATH)
    else:
        print('  npx (Node.js) introuvable : fichier non compressé (quantifié seulement)')
        shutil.copyfile(raw_path, OUT_PATH)
    print(f'Écrit {OUT_PATH} : {os.path.getsize(OUT_PATH) / 1e6:.1f} Mo · {nverts} sommets · {ntris} triangles · {len(tiles)} tuiles ({time.time() - t0:.0f} s)')

    write_preview(cover_poly, bld_poly, impl, vols, args.radius)


def compress_meshopt(src, dst):
    """
    Compression EXT_meshopt_compression (÷10 environ) via glTF Transform, si
    Node.js est installé — décodée côté page par MeshoptDecoder (voir
    gltfLoader.setMeshoptDecoder dans index.html).
    """
    r = subprocess.run([shutil.which('npx'), '-y', '@gltf-transform/cli@4', 'meshopt', src, dst],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError('compression meshopt impossible : ' + (r.stderr or r.stdout)[-600:])


def write_preview(cover_poly, bld_poly, impl, vols, radius):
    """Aperçu PNG des exclusions (gris : maquette actuelle, orange : Bâtis ajoutés, rouge : polygone d'implantation)."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    S, R = 1600, radius + GROUND_MARGIN
    img = Image.new('RGB', (S, S), (18, 24, 32))
    dr = ImageDraw.Draw(img)
    tr = lambda c: [((x + R) / (2 * R) * S, (z + R) / (2 * R) * S) for x, z in c]

    def fill(geom, color):
        for p in getattr(geom, 'geoms', [geom]):
            if p.geom_type == 'Polygon' and not p.is_empty:
                dr.polygon(tr(p.exterior.coords), fill=color)
    fill(cover_poly, (70, 78, 90))
    fill(bld_poly, (130, 140, 155))
    for p, _ in vols:
        dr.polygon(tr(p.exterior.coords), fill=(224, 140, 70))
    fill(impl, (230, 60, 60))
    path = os.path.join(CACHE_DIR, 'apercu.png')
    img.save(path)
    print('Aperçu :', path)


if __name__ == '__main__':
    main()
