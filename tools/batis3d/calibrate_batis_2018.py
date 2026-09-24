# -*- coding: utf-8 -*-
"""
calibrate_batis_2018.py — calage des Bâtis 3D 2018 sur le repère de la maquette
================================================================================
Les .glb de la page (place_de_milan.glb, global.glb) sont dans un repère
local Blender (mètres, Y vers le haut) qui n'est PAS exactement le Lambert
CC46 (EPSG:3946) des données de la Métropole : il est centré à peu près sur
la place (45.76211179556013, 4.858197572028974), orienté au nord
géographique (et non au nord du quadrillage Lambert) et légèrement mis à
l'échelle. Ce script mesure la similitude exacte (échelle + rotation +
translation) qui fait passer du Lambert CC46 au repère de la maquette :

  1. rasterise à 1 m l'empreinte des toits de global.glb (faces horizontales
     des matériaux de bâti, au-dessus de 5 m) ;
  2. rasterise de même l'empreinte des volumes de toiture Bâtis 3D 2018 ;
  3. cherche, tuile par tuile (160 m), le décalage qui maximise leur
     recouvrement (IoU) ;
  4. ajuste par moindres carrés robustes une similitude sur ce champ de
     décalages, et l'écrit dans georef.json (lu par build_batis_2018.py).

Usage (depuis la racine du site) :
    python tools/batis3d/calibrate_batis_2018.py

À ne relancer QUE si global.glb est déplacé/remis à l'échelle dans Blender.
Dépendances : numpy, shapely>=2, pyproj.
"""
import json
import os
import sys

import numpy as np
import shapely

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from glb_io import read_triangles  # noqa: E402
from build_batis_2018 import (SITE_DIR, CENTER_LATLON, fetch_layer, lambert_center,  # noqa: E402
                              LAYER_TOITS, GEOREF_PATH)

# Matériaux de global.glb qui correspondent à du bâti (le reste : sol, routes,
# rails, quais surélevés... fausserait le calage).
BUILDING_MATERIALS = {'BATIMENTS', 'BATIMENTS_fenetre', 'glass', 'glass_fenetre', 'glass_nolight',
                      'aluminium', 'tolyon', 'pyramide', 'BU', 'ppy', 'glass_carre', 'westfield'}
RES = 1.0          # m par pixel
TILE = 160         # taille des tuiles de recherche (pixels)
MAX_SHIFT = 25     # décalage max recherché par tuile (pixels)
MIN_ROOF_H = 5.0   # m — on ignore ce qui est plus bas (mobilier, auvents...)


def rasterize_triangles(tris_xz, x0, z0, nx, nz):
    img = np.zeros((nz, nx), bool)
    gx = x0 + (np.arange(nx) + .5) * RES
    gz = z0 + (np.arange(nz) + .5) * RES
    for a, b, c in tris_xz:
        lo = np.floor((np.minimum(np.minimum(a, b), c) - [x0, z0]) / RES).astype(int)
        hi = np.ceil((np.maximum(np.maximum(a, b), c) - [x0, z0]) / RES).astype(int)
        lo, hi = np.clip(lo, 0, [nx, nz]), np.clip(hi, 0, [nx, nz])
        if hi[0] <= lo[0] or hi[1] <= lo[1]:
            continue
        px, pz = np.meshgrid(gx[lo[0]:hi[0]], gz[lo[1]:hi[1]])
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-9:
            continue
        l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[1])) / d
        l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[1])) / d
        img[lo[1]:hi[1], lo[0]:hi[0]] |= (l1 >= 0) & (l2 >= 0) & (l1 + l2 <= 1)
    return img


def main():
    glb = os.path.join(SITE_DIR, 'global.glb')
    roofs = []
    for _name, mat, t in read_triangles(glb):
        if mat not in BUILDING_MATERIALS:
            continue
        n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        up = np.abs(n[:, 1]) / (np.linalg.norm(n, axis=1) + 1e-12) > 0.6
        roofs.append(t[up & (t[:, :, 1].mean(1) > MIN_ROOF_H)][:, :, [0, 2]])
    roofs = np.concatenate(roofs)
    x0, z0 = np.floor(roofs.reshape(-1, 2).min(0)) - 10
    x1, z1 = np.ceil(roofs.reshape(-1, 2).max(0)) + 10
    nx, nz = int((x1 - x0) / RES), int((z1 - z0) / RES)
    A = rasterize_triangles(roofs, x0, z0, nx, nz)

    # Bâtis dans le repère "brut" : x = Est, z = -Nord (convention glTF), centrés
    # sur le point de référence, sans rotation ni échelle (c'est ce qu'on mesure).
    e0, n0 = lambert_center()
    radius = max(abs(x0), abs(x1), abs(z0), abs(z1)) + 100
    feats = fetch_layer(LAYER_TOITS, radius)
    geoms = []
    for f in feats:
        if (f['properties'].get('htotale') or 0) < MIN_ROOF_H:
            continue
        c = np.array(f['geometry']['coordinates'][0])[:, :2] - [e0, n0]
        geoms.append(shapely.polygons(np.c_[c[:, 0], -c[:, 1]]))
    gx = x0 + (np.arange(nx) + .5) * RES
    gz = z0 + (np.arange(nz) + .5) * RES
    GX, GZ = np.meshgrid(gx, gz)
    ip, _ = shapely.STRtree(geoms).query(shapely.points(GX.ravel(), GZ.ravel()), predicate='within')
    B = np.zeros(nx * nz, bool)
    B[ip] = True
    B = B.reshape(nz, nx)

    # Champ de décalages par tuile
    rows = []
    for tz in range(0, nz - TILE + 1, TILE // 2):
        for tx in range(0, nx - TILE + 1, TILE // 2):
            a = A[tz:tz + TILE, tx:tx + TILE]
            if a.mean() < 0.12:
                continue
            best = (-1.0, 0, 0)
            for dz in range(-MAX_SHIFT, MAX_SHIFT + 1):
                for dx in range(-MAX_SHIFT, MAX_SHIFT + 1):
                    zs, xs = tz - dz, tx - dx
                    if zs < 0 or xs < 0 or zs + TILE > nz or xs + TILE > nx:
                        continue
                    b = B[zs:zs + TILE, xs:xs + TILE]
                    iou = (a & b).sum() / max(1, (a | b).sum())
                    if iou > best[0]:
                        best = (iou, dx, dz)
            iou, dx, dz = best
            if iou > 0.45 and abs(dx) < MAX_SHIFT - 1 and abs(dz) < MAX_SHIFT - 1:
                cx, cz = x0 + (tx + TILE / 2) * RES, z0 + (tz + TILE / 2) * RES
                rows.append((cx, cz, dx * RES, dz * RES))
    rows = np.array(rows)
    print(f'{len(rows)} tuiles exploitables')

    # Similitude complexe q = a*p + b, ajustée avec rejet itératif des aberrants
    q = rows[:, 0] + 1j * rows[:, 1]
    p = q - (rows[:, 2] + 1j * rows[:, 3])
    keep = np.ones(len(q), bool)
    for _ in range(4):
        M = np.c_[p[keep], np.ones(keep.sum())]
        (a, b), *_ = np.linalg.lstsq(M, q[keep], rcond=None)
        res = np.abs(a * p + b - q)
        keep = res < max(2.5 * np.median(res), 2.0)
    print(f'échelle {abs(a):.6f} · rotation {np.degrees(np.angle(a)):.4f}° · translation ({b.real:.2f}, {b.imag:.2f}) m')
    print(f'résidu médian {np.median(res[keep]):.2f} m sur {keep.sum()} tuiles')

    georef = {
        'comment': "Similitude Lambert CC46 -> repère glTF de la maquette : "
                   "p = (E-E0) + i*(-(N-N0)) ; q = a*p + b ; x = Re(q), z = Im(q), y = scale*(alt - z_ref). "
                   "Généré par calibrate_batis_2018.py",
        'center_latlon': CENTER_LATLON,
        'E0': e0, 'N0': n0,
        'scale': float(abs(a)),
        'rotation_deg': float(np.degrees(np.angle(a))),
        'tx': float(b.real), 'tz': float(b.imag),
        'residual_median_m': float(np.median(res[keep])),
    }
    # z_ref / y_offset (calage vertical) sont conservés s'ils existent déjà
    if os.path.exists(GEOREF_PATH):
        old = json.load(open(GEOREF_PATH, encoding='utf-8'))
        for k in ('z_ref', 'y_offset'):
            if k in old:
                georef[k] = old[k]
    georef.setdefault('z_ref', 167.8)
    georef.setdefault('y_offset', 0.0)
    json.dump(georef, open(GEOREF_PATH, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print('écrit :', GEOREF_PATH)


if __name__ == '__main__':
    main()
