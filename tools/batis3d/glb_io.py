# -*- coding: utf-8 -*-
"""
glb_io.py — lecture/écriture minimale de fichiers .glb (glTF 2.0 binaire)
=========================================================================
Utilitaire partagé par build_batis_2018.py et calibrate_batis_2018.py.
Aucune dépendance autre que numpy.

  - read_triangles(path)  : tous les triangles d'un .glb, en coordonnées
                            MONDE glTF (transformations de nœuds appliquées),
                            avec le nom du nœud et du matériau.
  - write_glb(path, ...)  : écrit un .glb (float32, ou quantifié
                            KHR_mesh_quantization : positions int16 + normales
                            int8), une primitive par matériau et par tuile.
"""
import json
import struct

import numpy as np

_CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


# ---------------------------------------------------------------- lecture
def _load(path):
    b = open(path, 'rb').read()
    off, chunks = 12, []
    while off < len(b):
        ln, _t = struct.unpack('<II', b[off:off + 8])
        chunks.append(b[off + 8:off + 8 + ln])
        off += 8 + ln
    return json.loads(chunks[0]), (chunks[1] if len(chunks) > 1 else b'')


def _accessor(g, bin_, i):
    a = g['accessors'][i]
    bv = g['bufferViews'][a['bufferView']]
    dt, n = _CT[a['componentType']], _NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride, isz = bv.get('byteStride', 0), np.dtype(dt).itemsize * n
    if stride and stride != isz:
        raw = np.frombuffer(bin_, np.uint8, count=stride * a['count'], offset=off).reshape(a['count'], stride)[:, :isz]
        out = np.frombuffer(raw.tobytes(), dt).reshape(a['count'], n)
    else:
        out = np.frombuffer(bin_, dt, count=a['count'] * n, offset=off).reshape(a['count'], n)
    return out


def _trs(n):
    if 'matrix' in n:
        return np.array(n['matrix'], float).reshape(4, 4).T
    t = n.get('translation', [0, 0, 0])
    x, y, z, w = n.get('rotation', [0, 0, 0, 1])
    s = n.get('scale', [1, 1, 1])
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m = np.eye(4)
    m[:3, :3] = r * np.array(s)
    m[:3, 3] = t
    return m


def read_triangles(path):
    """Liste de (nom_noeud, nom_materiau, tris[N,3,3]) en coordonnées monde glTF."""
    g, bin_ = _load(path)
    out = []

    def walk(i, parent):
        n = g['nodes'][i]
        m = parent @ _trs(n)
        if 'mesh' in n:
            for pr in g['meshes'][n['mesh']]['primitives']:
                if pr.get('mode', 4) != 4:
                    continue
                p = _accessor(g, bin_, pr['attributes']['POSITION']).astype(np.float64)
                p = (np.c_[p, np.ones(len(p))] @ m.T)[:, :3]
                idx = _accessor(g, bin_, pr['indices']).reshape(-1) if 'indices' in pr else np.arange(len(p))
                mat = g['materials'][pr['material']].get('name') if 'material' in pr else None
                out.append((n.get('name', ''), mat, p[idx.reshape(-1, 3)]))
        for c in n.get('children', []):
            walk(c, m)

    for i in g['scenes'][g.get('scene', 0)]['nodes']:
        walk(i, np.eye(4))
    return out


# ---------------------------------------------------------------- écriture
def _pad4(b, fill=b'\x00'):
    return b + fill * ((4 - len(b) % 4) % 4)


def write_glb(path, tiles, materials, extras=None, quantize=True):
    """
    tiles     : liste de dicts {name, center:(x,y,z), prims:{mat_name: (positions[N,3] float, normals[N,3] float | None, indices[M] int)}}
                (normals=None : pas d'attribut NORMAL, Three.js passe alors le
                matériau en flatShading — ombrage à facettes sans dupliquer les sommets)
                (positions en coordonnées monde ; avec quantize=True elles sont
                quantifiées en int16 relativement au centre de la tuile, l'échelle
                étant portée par le nœud — sinon float32, relativement au centre).
    materials : dict {mat_name: {'color':(r,g,b), 'metallic':f, 'roughness':f}}
    """
    mat_names = list(materials)
    gl = {
        'asset': {'version': '2.0', 'generator': 'tools/batis3d/build_batis_2018.py'},
        'scene': 0,
        'scenes': [{'name': 'Batis3D2018', 'nodes': []}],
        'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': [], 'buffers': [],
        'materials': [{
            'name': k,
            'doubleSided': True,
            'pbrMetallicRoughness': {
                'baseColorFactor': list(v['color']) + [1.0],
                'metallicFactor': v.get('metallic', 0.0),
                'roughnessFactor': v.get('roughness', 0.8),
            },
        } for k, v in materials.items()],
    }
    if quantize:
        gl['extensionsUsed'] = gl['extensionsRequired'] = ['KHR_mesh_quantization']
    if extras:
        gl['scenes'][0]['extras'] = extras
    blob = bytearray()

    def add_view(data, stride=None, target=None):
        nonlocal blob
        blob = bytearray(_pad4(bytes(blob)))
        bv = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)}
        if stride:
            bv['byteStride'] = stride
        if target:
            bv['target'] = target
        blob += data
        gl['bufferViews'].append(bv)
        return len(gl['bufferViews']) - 1

    def add_acc(view, ctype, count, typ, normalized=False, mn=None, mx=None):
        a = {'bufferView': view, 'componentType': ctype, 'count': int(count), 'type': typ}
        if normalized:
            a['normalized'] = True
        if mn is not None:
            a['min'], a['max'] = mn, mx
        gl['accessors'].append(a)
        return len(gl['accessors']) - 1

    for tile in tiles:
        prims_out = []
        allp = np.concatenate([p for p, _, _ in tile['prims'].values()]) if tile['prims'] else None
        if allp is None or not len(allp):
            continue
        center = np.asarray(tile['center'], float)
        half = np.abs(allp - center).max() + 1e-3
        q = half / 32767.0 if quantize else 1.0  # pas de quantification (m)
        for mat, (pos, nor, idx) in tile['prims'].items():
            if not len(idx):
                continue
            if quantize:
                qp = np.round((pos - center) / q).astype(np.int16)
                p4 = np.zeros((len(qp), 4), np.int16)
                p4[:, :3] = qp
                vp = add_view(p4.tobytes(), stride=8, target=34962)
                ap = add_acc(vp, 5122, len(qp), 'VEC3', mn=qp.min(0).astype(int).tolist(), mx=qp.max(0).astype(int).tolist())
                if nor is not None:
                    qn = np.clip(np.round(nor * 127), -127, 127).astype(np.int8)
                    n4 = np.zeros((len(qn), 4), np.int8)
                    n4[:, :3] = qn
                    vn = add_view(n4.tobytes(), stride=4, target=34962)
                    an = add_acc(vn, 5120, len(qn), 'VEC3', normalized=True)
            else:
                fp = (pos - center).astype(np.float32)
                vp = add_view(fp.tobytes(), target=34962)
                ap = add_acc(vp, 5126, len(fp), 'VEC3', mn=fp.min(0).tolist(), mx=fp.max(0).tolist())
                if nor is not None:
                    vn = add_view(np.asarray(nor, np.float32).tobytes(), target=34962)
                    an = add_acc(vn, 5126, len(fp), 'VEC3')
            idx = np.asarray(idx)
            ityp, ict = (np.uint16, 5123) if len(pos) < 65536 else (np.uint32, 5125)
            vi = add_view(idx.astype(ityp).tobytes(), target=34963)
            ai = add_acc(vi, ict, len(idx), 'SCALAR')
            attrs = {'POSITION': ap}
            if nor is not None:
                attrs['NORMAL'] = an
            prims_out.append({'attributes': attrs, 'indices': ai,
                              'material': mat_names.index(mat), 'mode': 4})
        if not prims_out:
            continue
        gl['meshes'].append({'name': tile['name'], 'primitives': prims_out})
        node = {'name': tile['name'], 'mesh': len(gl['meshes']) - 1, 'translation': center.tolist()}
        if quantize:
            node['scale'] = [q, q, q]
        gl['nodes'].append(node)
        gl['scenes'][0]['nodes'].append(len(gl['nodes']) - 1)

    blob = _pad4(bytes(blob))
    gl['buffers'].append({'byteLength': len(blob)})
    js = _pad4(json.dumps(gl, separators=(',', ':')).encode('utf-8'), b' ')
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(blob), 0x004E4942) + blob)
