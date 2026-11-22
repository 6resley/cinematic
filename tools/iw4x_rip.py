#!/usr/bin/env python3
"""
iw4x_rip.py - dump XModels from a running IW4x / MW2 (2009) multiplayer process to OBJ.

Usage (Windows, game running and you spawned in a match):
    python iw4x_rip.py                 export every loaded model with "ghillie" in its name
    python iw4x_rip.py --list          list every loaded model name
    python iw4x_rip.py riot_shield     export models whose name contains "riot_shield"
    python iw4x_rip.py --swap-uv       use if textures look scrambled on the mesh
    python iw4x_rip.py --anims sprint  export every loaded animation with "sprint" in the name

Each model is written as .obj (mesh only) and .glb (mesh + skeleton + skin weights).
Bodies that have a matching head also get <body>_with_head.glb: one mesh, one skeleton.
Run iw4x_textures.py first if you want the .glb to reference the textures.
Output goes to a "ripped" folder next to where you run it.
"""
import argparse
import ctypes
import os
import struct
from array import array
import subprocess
import sys

PROCESS_NAMES = ("iw4x.exe", "iw4mp.exe", "iw4m.exe")

# IW4 (1.2.159 base, used by IW4x) fixed addresses
DB_XASSET_POOL = 0x7998A8   # void* pools[ASSET_TYPE_COUNT]
G_POOL_SIZE = 0x7995E8      # uint  sizes[ASSET_TYPE_COUNT]
ASSET_TYPE_XMODEL = 4

XMODEL_SIZE = 0x130
XSURFACE_SIZE = 0x40
VERTEX_SIZE = 32

NAME_CHARS = set(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./$~ ")


class ProcessMemory:
    """Read-only view of another process's memory (Windows only)."""

    def __init__(self, pid):
        from ctypes import wintypes
        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k32.OpenProcess.restype = wintypes.HANDLE
        self.k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.k32.ReadProcessMemory.restype = wintypes.BOOL
        self.k32.ReadProcessMemory.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        self.k32.VirtualQueryEx.restype = ctypes.c_size_t
        self.k32.VirtualQueryEx.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        # PROCESS_VM_READ | PROCESS_QUERY_INFORMATION
        self.handle = self.k32.OpenProcess(0x0010 | 0x0400, False, pid)
        if not self.handle:
            raise OSError("OpenProcess failed (error %d). Run this from an "
                          "Administrator command prompt." % ctypes.get_last_error())

    def read(self, addr, size):
        if size <= 0 or addr <= 0xFFFF or addr + size > 0x100000000:
            return None
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t(0)
        ok = self.k32.ReadProcessMemory(self.handle, ctypes.c_void_p(addr), buf, size,
                                        ctypes.byref(got))
        if not ok or got.value != size:
            return None
        return buf.raw

    def regions(self):
        """Yield (base, size) for committed readable regions below 4 GB."""
        class MBI(ctypes.Structure):
            _fields_ = [("BaseAddress", ctypes.c_void_p),
                        ("AllocationBase", ctypes.c_void_p),
                        ("AllocationProtect", ctypes.c_ulong),
                        ("RegionSize", ctypes.c_size_t),
                        ("State", ctypes.c_ulong),
                        ("Protect", ctypes.c_ulong),
                        ("Type", ctypes.c_ulong)]
        mbi = MBI()
        addr = 0x10000
        while addr < 0x100000000:
            if not self.k32.VirtualQueryEx(self.handle, ctypes.c_void_p(addr),
                                           ctypes.byref(mbi), ctypes.sizeof(mbi)):
                break
            base = mbi.BaseAddress or 0
            size = mbi.RegionSize
            if size == 0:
                break
            readable = mbi.Protect & 0xEE and not mbi.Protect & 0x101
            if mbi.State == 0x1000 and readable:
                yield base, size
            addr = base + size


def find_pid():
    out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True,
                         text=True).stdout
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() in PROCESS_NAMES:
            return int(parts[1]), parts[0]
    return None, None


# ---------------------------------------------------------------- helpers

def u32(mem, addr):
    d = mem.read(addr, 4)
    return struct.unpack("<I", d)[0] if d else 0


def cstr(mem, addr, maxlen=128):
    """Read a plausible asset-name string, or None."""
    for n in (maxlen, 32, 8):          # shrink if the string sits at a region end
        d = mem.read(addr, n)
        if d:
            break
    else:
        return None
    end = d.find(b"\0")
    if end < 2:
        return None
    s = d[:end]
    if any(c not in NAME_CHARS for c in s):
        return None
    return s.decode("ascii")


# ---------------------------------------------------------------- locating models

def models_from_pool(mem):
    pool = u32(mem, DB_XASSET_POOL + 4 * ASSET_TYPE_XMODEL)
    count = u32(mem, G_POOL_SIZE + 4 * ASSET_TYPE_XMODEL)
    print("xmodel pool at 0x%08X, capacity %d" % (pool, count))
    if not pool or not 0 < count < 200000:
        return {}
    best = {}
    for header in (0, 4):              # pool may or may not start with a free-list pointer
        found = {}
        for i in range(count):
            a = pool + header + i * XMODEL_SIZE
            name = cstr(mem, u32(mem, a))
            if name:
                found[a] = name
        if len(found) > len(best):
            best = found
    return best


def models_from_scan(mem, needle):
    """Fallback: find name strings in memory, then structs that point at them."""
    print("pool lookup found nothing; scanning process memory (can take a minute)...")
    needle_b = needle.encode("ascii")
    chunk = 16 * 1024 * 1024
    strings = {}
    regions = list(mem.regions())
    for base, size in regions:
        for off in range(0, size, chunk):
            d = mem.read(base + off, min(chunk, size - off))
            if not d:
                continue
            pos = d.find(needle_b)
            while pos != -1:
                start = d.rfind(b"\0", 0, pos) + 1
                name = cstr(mem, base + off + start)
                if name:
                    strings[base + off + start] = name
                pos = d.find(needle_b, pos + 1)
    print("found %d candidate name strings" % len(strings))
    found = {}
    packed = {struct.pack("<I", a): n for a, n in strings.items()}
    for base, size in regions:
        for off in range(0, size, chunk):
            d = mem.read(base + off, min(chunk, size - off))
            if not d:
                continue
            for pat, name in packed.items():
                pos = d.find(pat)
                while pos != -1:
                    a = base + off + pos
                    head = mem.read(a, XMODEL_SIZE)
                    # numsurfs sane, scale sane, lod0 has surfaces
                    if head and 1 <= head[6] <= 64:
                        scale = struct.unpack_from("<f", head, 8)[0]
                        lod_surfs = struct.unpack_from("<H", head, 68)[0]
                        if 0.001 < scale < 1000 and 1 <= lod_surfs <= 64:
                            found[a] = name
                    pos = d.find(pat, pos + 1)
    return found


# ---------------------------------------------------------------- skeleton

BONE_HINTS = (b"tag_origin\0", b"j_mainroot\0", b"j_spine4\0", b"j_head\0", b"j_neck\0",
              b"j_helmet\0", b"tag_weapon_right\0", b"j_wrist_ri\0", b"tag_view\0",
              b"tag_weapon\0", b"j_gun\0", b"tag_torso\0", b"tag_camera\0", b"tag_flash\0",
              b"tag_brass\0", b"tag_clip\0", b"j_bolt\0", b"tag_origin\0"[:0] or b"tag_eye\0", b"j_spineupper\0", b"pelvis\0")
_SCR = {"hits": None, "base": None, "stride": 12}


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qconj(q):
    return (-q[0], -q[1], -q[2], q[3])


def qrot(q, v):
    x, y, z, _ = qmul(qmul(q, (v[0], v[1], v[2], 0.0)), qconj(q))
    return (x, y, z)


def qnorm(q):
    n = sum(c * c for c in q) ** 0.5
    return tuple(c / n for c in q) if n > 1e-6 else (0.0, 0.0, 0.0, 1.0)


def _names_at(mem, base, stride, ids):
    names = []
    for i in ids:
        n = cstr(mem, base + stride * i + 4, 64)
        if not n:
            return None
        names.append(n)
    return names if len(set(names)) == len(names) else None


BONE_PREFIXES = ("j_", "tag_", "bi_", "pelvis", "torso_", "back_")


def _trustworthy(names):
    """A real bone list is mostly j_/tag_ names and contains at least two of the well-known ones.

    Any base that is off by a whole number of table slots still reads valid strings, so "every name is a
    readable string" is not enough to accept a candidate.
    """
    if not names:
        return False
    known = {h[:-1].decode() for h in BONE_HINTS}
    bone_like = sum(n.startswith(BONE_PREFIXES) for n in names) / float(len(names))
    return bone_like >= 0.8 and len(known.intersection(names)) >= min(2, len(names))


def bone_names(mem, ids):
    """Resolve script-string ids to names by locating the game's string table."""
    if _SCR["base"]:
        names = _names_at(mem, _SCR["base"], _SCR["stride"], ids)
        if names:
            return names
        print("  ! bone names for this model are not in the located table")
        return ["bone_%d" % i for i in range(len(ids))]
    if _SCR["hits"] is None:
        print("  locating bone-name table (one-time memory scan, can take a minute)...")
        hits = []
        chunk = 16 * 1024 * 1024
        for base, size in mem.regions():
            for off in range(0, size, chunk):
                d = mem.read(base + off, min(chunk, size - off))
                if not d:
                    continue
                for hint in BONE_HINTS:
                    pos = d.find(hint)
                    while pos != -1:
                        hits.append((base + off + pos, hint[:-1].decode()))
                        pos = d.find(hint, pos + 1)
        _SCR["hits"] = hits
    uniq = sorted(set(ids))
    for stride in (12, 16):
        tried = set()
        for s, hint in _SCR["hits"]:
            for i in uniq:
                base = s - 4 - stride * i
                if base <= 0 or base in tried:
                    continue
                tried.add(base)
                names = _names_at(mem, base, stride, ids)
                if names and _trustworthy(names):
                    _SCR["base"], _SCR["stride"] = base, stride
                    print("  bone-name table at 0x%08X (stride %d)" % (base, stride))
                    return names
    print("  ! could not resolve bone names for this model; using bone_0, bone_1, ...")
    return ["bone_%d" % i for i in range(len(ids))]


def read_skeleton(mem, head):
    """Return list of bones: dict(name, parent, gq, gt, lq, lt) or None if no bones."""
    nb, nroot = head[4], head[5]
    if nb == 0:
        return None
    names_ptr, parent_ptr, quats_ptr, trans_ptr = struct.unpack_from("<IIII", head, 36)
    basemat_ptr = struct.unpack_from("<I", head, 56)[0]
    raw = mem.read(names_ptr, nb * 2)
    if not raw:
        raise ValueError("bone name ids not readable")
    ids = struct.unpack("<%dH" % nb, raw)
    parents = [-1] * nb
    nchild = nb - nroot
    if nchild > 0:
        pl = mem.read(parent_ptr, nchild)
        if not pl:
            raise ValueError("parent list not readable")
        for i in range(nroot, nb):
            p = i - pl[i - nroot]
            parents[i] = p if 0 <= p < i else -1

    glob = None
    bm = mem.read(basemat_ptr, nb * 32)
    if bm:
        glob = []
        for i in range(nb):
            qx, qy, qz, qw, tx, ty, tz, _w = struct.unpack_from("<8f", bm, i * 32)
            n = (qx * qx + qy * qy + qz * qz + qw * qw) ** 0.5
            if not 0.9 < n < 1.1:
                glob = None
                break
            glob.append((qnorm((qx, qy, qz, qw)), (tx, ty, tz)))
    if glob is None:
        print("  (bind matrices not usable; building pose from local transforms)")
        q = mem.read(quats_ptr, nchild * 8) if nchild > 0 else b""
        t = mem.read(trans_ptr, nchild * 12) if nchild > 0 else b""
        if nchild > 0 and (not q or not t):
            raise ValueError("local bone transforms not readable")
        glob = []
        for i in range(nb):
            if i < nroot or parents[i] < 0:
                glob.append(((0.0, 0.0, 0.0, 1.0), (0.0, 0.0, 0.0)))
                continue
            lq = qnorm(tuple(c / 32767.0 for c in
                             struct.unpack_from("<4h", q, (i - nroot) * 8)))
            lt = struct.unpack_from("<3f", t, (i - nroot) * 12)
            pq, pt = glob[parents[i]]
            r = qrot(pq, lt)
            glob.append((qnorm(qmul(pq, lq)), (pt[0] + r[0], pt[1] + r[1], pt[2] + r[2])))

    names = bone_names(mem, ids)
    bones = []
    for i in range(nb):
        gq, gt = glob[i]
        if parents[i] < 0:
            lq, lt = gq, gt
        else:
            pq, pt = glob[parents[i]]
            lq = qnorm(qmul(qconj(pq), gq))
            lt = qrot(qconj(pq), (gt[0] - pt[0], gt[1] - pt[1], gt[2] - pt[2]))
        bones.append({"name": names[i], "parent": parents[i],
                      "gq": gq, "gt": gt, "lq": lq, "lt": lt})
    return bones


def read_weights(mem, s, vert_count, num_bones):
    """Per-vertex [(bone, weight)] from an XSurface's rigid lists and blend data."""
    w = [[(0, 1.0)] for _ in range(vert_count)]
    counts = struct.unpack_from("<4h", s, 16)
    blend_ptr = struct.unpack_from("<I", s, 24)[0]
    vl_count, vl_ptr = struct.unpack_from("<II", s, 32)
    bad = 0
    if vl_ptr and 0 < vl_count <= 512:
        d = mem.read(vl_ptr, vl_count * 12)
        vi = 0
        if d:
            for j in range(vl_count):
                bone_off, vc = struct.unpack_from("<HH", d, j * 12)
                for _ in range(vc):
                    if vi < vert_count:
                        w[vi] = [(bone_off // 64, 1.0)]
                    vi += 1
    if blend_ptr and min(counts) >= 0 and 0 < sum(counts) <= vert_count:
        n16 = counts[0] + 3 * counts[1] + 5 * counts[2] + 7 * counts[3]
        d = mem.read(blend_ptr, n16 * 2)
        if d:
            vals = struct.unpack("<%dH" % n16, d)
            p = vi = 0
            for extra in range(4):
                for _ in range(counts[extra]):
                    first = vals[p] // 64
                    p += 1
                    rest, acc = [], 0.0
                    for _ in range(extra):
                        wt = vals[p + 1] / 65536.0
                        rest.append((vals[p] // 64, wt))
                        acc += wt
                        p += 2
                    w[vi] = [(first, max(0.0, 1.0 - acc))] + rest
                    vi += 1
    for i, infl in enumerate(w):
        fixed = []
        for b, wt in infl:
            if b >= num_bones:
                bad += 1
                b = 0
            fixed.append((b, wt))
        total = sum(wt for _, wt in fixed) or 1.0
        w[i] = [(b, wt / total) for b, wt in fixed][:4]
    if bad:
        print("    ! %d weights referenced out-of-range bones (set to bone 0)" % bad)
    return w


# ---------------------------------------------------------------- export

def hexdump(data, base):
    lines = []
    for i in range(0, len(data), 16):
        row = data[i:i + 16]
        lines.append("%08X  %s" % (base + i, " ".join("%02X" % b for b in row)))
    return "\n".join(lines)


UNREAD_IMAGES = []


def _loose_name(mem, addr):
    """An image name with characters asset names do not normally have (still printable, no path tricks)."""
    d = mem.read(addr, 96) or mem.read(addr, 32)
    if not d:
        return None
    end = d.find(b"\0")
    if end < 3:
        return None
    text = d[:end]
    if any(c < 0x21 or c > 0x7E or c in b'\\/:*?"<>|' for c in text):
        return None
    return text.decode("ascii")


def material_draw_info(mem, mat_ptr):
    """(technique set name, sort key): how the game draws a material - solid, cut-out, blended or added."""
    head = mem.read(mat_ptr, 96)
    if not head:
        return None, 0
    return cstr(mem, u32(mem, struct.unpack_from("<I", head, 80)[0])), head[5]


def material_textures(mem, mat_ptr):
    """Return [(semantic, image_name)] for a Material, best effort."""
    out = []
    head = mem.read(mat_ptr, 96)
    if not head:
        return out
    tex_count = head[72]
    table = struct.unpack_from("<I", head, 84)[0]
    for j in range(min(tex_count, 16)):
        td = mem.read(table + 12 * j, 12)
        if not td:
            break
        image = struct.unpack_from("<I", td, 8)[0]
        for off in (28, 24, 32, 20):   # GfxImage.name offset, try likely spots
            name = cstr(mem, u32(mem, image + off)) or _loose_name(mem, u32(mem, image + off))
            if name:
                out.append((td[7], name))
                break
        else:
            UNREAD_IMAGES.append((cstr(mem, u32(mem, mat_ptr)), td[7], image))
    return out


def color_map(textures):
    for sem, img in textures:
        if sem == 2:
            return img
    for _sem, img in textures:
        if img.lower().endswith(("_col", "_c", "_color")):
            return img
    return None


def write_obj(path_base, name, surfaces):
    safe = os.path.basename(path_base)
    obj = ["# %s ripped from IW4x memory" % name, "mtllib %s.mtl" % safe]
    mtl, tex, seen = [], [], set()
    vbase = 1
    for i, s in enumerate(surfaces):
        if s["material"] not in seen:
            seen.add(s["material"])
            mtl.append("newmtl %s\nKd 0.8 0.8 0.8\n" % s["material"])
            for semantic, image in s["textures"]:
                tex.append("%s\tsemantic=%d\timages/%s.iwi" % (s["material"], semantic, image))
        obj.append("g surf_%d\nusemtl %s" % (i, s["material"]))
        obj.extend("v %.6f %.6f %.6f" % p for p in s["pos"])
        obj.extend("vt %.6f %.6f" % (u, 1.0 - v) for u, v in s["uv"])
        obj.extend("vn %.6f %.6f %.6f" % n for n in s["nrm"])
        for a, b, c in s["tris"]:
            a, b, c = a + vbase, b + vbase, c + vbase
            obj.append("f %d/%d/%d %d/%d/%d %d/%d/%d" % (c, c, c, b, b, b, a, a, a))
        vbase += len(s["pos"])
    with open(path_base + ".obj", "w") as f:
        f.write("\n".join(obj) + "\n")
    # keep an .mtl that iw4x_textures.py already filled in
    if not os.path.exists(path_base + ".mtl") or "map_Kd" not in open(path_base + ".mtl").read():
        with open(path_base + ".mtl", "w") as f:
            f.write("\n".join(mtl))
    with open(path_base + "_textures.txt", "w") as f:
        f.write("\n".join(tex) + "\n")


def write_glb(path_base, name, surfaces, bones, outdir):
    import json
    binbuf = bytearray()
    views, accessors = [], []

    def add(data, ctype, count, typ, target=None, minmax=None):
        while len(binbuf) % 4:
            binbuf.append(0)
        view = {"buffer": 0, "byteOffset": len(binbuf), "byteLength": len(data)}
        if target:
            view["target"] = target
        binbuf.extend(data)
        views.append(view)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": count,
               "type": typ}
        if minmax:
            acc["min"], acc["max"] = minmax
        accessors.append(acc)
        return len(accessors) - 1

    materials, mat_index, images, textures = [], {}, [], []
    prims = []
    for s in surfaces:
        n = len(s["pos"])
        flat = [c for p in s["pos"] for c in p]
        mn = [min(flat[k::3]) for k in range(3)]
        mx = [max(flat[k::3]) for k in range(3)]
        attrs = {
            "POSITION": add(struct.pack("<%df" % (n * 3), *flat), 5126, n, "VEC3", 34962,
                            (mn, mx)),
            "NORMAL": add(struct.pack("<%df" % (n * 3), *[c for v in s["nrm"] for c in
                                                         qnorm3(v)]), 5126, n, "VEC3", 34962),
            "TEXCOORD_0": add(struct.pack("<%df" % (n * 2), *[c for v in s["uv"] for c in v]),
                              5126, n, "VEC2", 34962),
        }
        if bones:
            joints, weights = [], []
            for infl in s["weights"]:
                infl = infl + [(0, 0.0)] * (4 - len(infl))
                joints.extend(b for b, _ in infl)
                weights.extend(wt for _, wt in infl)
            attrs["JOINTS_0"] = add(struct.pack("<%dH" % (n * 4), *joints), 5123, n, "VEC4",
                                    34962)
            attrs["WEIGHTS_0"] = add(struct.pack("<%df" % (n * 4), *weights), 5126, n, "VEC4",
                                     34962)
        idx = [i for a, b, c in s["tris"] for i in (c, b, a)]
        indices = add(struct.pack("<%dH" % len(idx), *idx), 5123, len(idx), "SCALAR", 34963)
        if s["material"] not in mat_index:
            mat = {"name": s["material"], "doubleSided": True,
                   "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.9}}
            img = color_map(s["textures"])
            if img and os.path.exists(os.path.join(outdir, "textures", img + ".dds")):
                images.append({"uri": "textures/%s.dds" % img, "name": img})
                textures.append({"source": len(images) - 1})
                mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(textures) - 1}
                if "mtl_sniper_ghillie" in s["material"]:
                    mat["alphaMode"] = "MASK"
                    mat["alphaCutoff"] = 0.5
            mat_index[s["material"]] = len(materials)
            materials.append(mat)
        prims.append({"attributes": attrs, "indices": indices,
                      "material": mat_index[s["material"]]})

    # node 0: holder that converts the game's Z-up inches to glTF's Y-up metres
    root = {"name": name, "rotation": [-0.70710678, 0.0, 0.0, 0.70710678],
            "scale": [0.0254, 0.0254, 0.0254], "children": []}
    nodes = [root]
    gltf = {"asset": {"version": "2.0", "generator": "iw4x_rip.py"}, "scene": 0,
            "meshes": [{"name": name, "primitives": prims}], "materials": materials}
    if bones:
        for i, b in enumerate(bones):
            nodes.append({"name": b["name"], "translation": list(b["lt"]),
                          "rotation": list(b["lq"])})
        for i, b in enumerate(bones):
            parent = nodes[b["parent"] + 1] if b["parent"] >= 0 else root
            parent.setdefault("children", []).append(i + 1)
        ibm = []
        for b in bones:
            x, y, z, w = b["gq"]
            r = ((1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
                 (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
                 (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)))
            t = qrot(qconj(b["gq"]), b["gt"])
            ibm.extend([r[0][0], r[0][1], r[0][2], 0.0, r[1][0], r[1][1], r[1][2], 0.0,
                        r[2][0], r[2][1], r[2][2], 0.0, -t[0], -t[1], -t[2], 1.0])
        ibm_acc = add(struct.pack("<%df" % len(ibm), *ibm), 5126, len(bones), "MAT4")
        gltf["skins"] = [{"joints": list(range(1, len(bones) + 1)),
                          "inverseBindMatrices": ibm_acc, "name": name + "_skeleton"}]
        nodes.append({"name": name + "_mesh", "mesh": 0, "skin": 0})
        gltf["scenes"] = [{"nodes": [0, len(nodes) - 1]}]
    else:
        nodes.append({"name": name + "_mesh", "mesh": 0})
        root["children"].append(1)
        gltf["scenes"] = [{"nodes": [0]}]
    gltf["nodes"] = nodes
    gltf["accessors"] = accessors
    gltf["bufferViews"] = views
    if images:
        gltf["images"], gltf["textures"] = images, textures
    while len(binbuf) % 4:
        binbuf.append(0)
    gltf["buffers"] = [{"byteLength": len(binbuf)}]
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    with open(path_base + ".glb", "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binbuf)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binbuf), 0x004E4942) + bytes(binbuf))


def qnorm3(v):
    n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) ** 0.5
    return (v[0] / n, v[1] / n, v[2] / n) if n > 1e-6 else (0.0, 0.0, 1.0)


def export_model(mem, addr, name, outdir, swap_uv=False):
    head = mem.read(addr, XMODEL_SIZE)
    if not head:
        print("  ! could not read model struct")
        return None
    num_bones = head[4]
    mats = struct.unpack_from("<I", head, 60)[0]
    lod_numsurfs, lod_surfindex, model_surfs = struct.unpack_from("<HHI", head, 68)
    surfs = struct.unpack_from("<I", head, 100)[0]
    if not mem.read(surfs, XSURFACE_SIZE):
        surfs = u32(mem, model_surfs + 4)
    print("  surfaces: %d (lod0), bones: %d" % (lod_numsurfs, num_bones))
    if not 1 <= lod_numsurfs <= 255 or not mem.read(surfs, XSURFACE_SIZE):
        print("  ! struct layout did not match; send this dump back:")
        print(hexdump(head, addr))
        return None

    surfaces = []
    for i in range(lod_numsurfs):
        s = mem.read(surfs + i * XSURFACE_SIZE, XSURFACE_SIZE)
        vert_count, tri_count = struct.unpack_from("<HH", s, 2)
        tri_ptr = struct.unpack_from("<I", s, 12)[0]
        vert_ptr = struct.unpack_from("<I", s, 28)[0]
        vdata = mem.read(vert_ptr, vert_count * VERTEX_SIZE)
        idata = mem.read(tri_ptr, tri_count * 6)
        mat_ptr = u32(mem, mats + 4 * (lod_surfindex + i))
        mat_name = cstr(mem, u32(mem, mat_ptr)) or "material_%d" % i
        print("  surf %d: %d verts, %d tris, material %s" %
              (i, vert_count, tri_count, mat_name))
        if not vdata or not idata:
            print("    ! vertex/index data not readable (verts 0x%08X tris 0x%08X)"
                  % (vert_ptr, tri_ptr))
            print(hexdump(s, surfs + i * XSURFACE_SIZE))
            continue
        pos, uvs, nrms = [], [], []
        for x, y, z, _bs, _col, uv, nrm, _tan in struct.iter_unpack("<ffffIIII", vdata):
            pos.append((x, y, z))
            hi = struct.unpack("<e", struct.pack("<H", uv >> 16))[0]
            lo = struct.unpack("<e", struct.pack("<H", uv & 0xFFFF))[0]
            uvs.append((lo, hi) if swap_uv else (hi, lo))
            scale = ((nrm >> 24) + 192.0) / 32385.0
            nrms.append((((nrm & 0xFF) - 127.0) * scale,
                         ((nrm >> 8 & 0xFF) - 127.0) * scale,
                         ((nrm >> 16 & 0xFF) - 127.0) * scale))
        surfaces.append({
            "material": mat_name, "textures": material_textures(mem, mat_ptr),
            "pos": pos, "uv": uvs, "nrm": nrms,
            "tris": list(struct.iter_unpack("<HHH", idata)),
            "weights": read_weights(mem, s, vert_count, max(num_bones, 1)),
        })
    if not surfaces:
        return None

    os.makedirs(outdir, exist_ok=True)
    safe = name.replace("/", "_").replace("\\", "_")
    base = os.path.join(outdir, safe)
    write_obj(base, name, surfaces)
    print("  -> %s.obj" % base)
    bones = None
    try:
        bones = read_skeleton(mem, head)
        write_glb(base, name, surfaces, bones, outdir)
        print("  -> %s.glb (%s)" % (base, "%d bones, skinned" % len(bones) if bones
                                    else "no bones"))
    except Exception as e:                      # keep the OBJ even if rigging fails
        print("  ! rigged export failed: %r" % (e,))
    return {"name": name, "surfaces": surfaces, "bones": bones}


def merge_models(body, head):
    """Attach a head model to a body: one mesh list, one skeleton. None if they don't fit."""
    if not body["bones"] or not head["bones"]:
        return None
    bones = [dict(b) for b in body["bones"]]
    index = {b["name"]: i for i, b in enumerate(bones)}
    root = next((b for b in head["bones"] if b["parent"] < 0 and b["name"] in index), None)
    if root is None:
        return None
    anchor = bones[index[root["name"]]]
    # the head is stored relative to its root bone; move it onto the body's copy of that bone
    tq = qnorm(qmul(anchor["gq"], qconj(root["gq"])))
    r = qrot(tq, root["gt"])
    tt = (anchor["gt"][0] - r[0], anchor["gt"][1] - r[1], anchor["gt"][2] - r[2])

    def xf(p):
        v = qrot(tq, p)
        return (v[0] + tt[0], v[1] + tt[1], v[2] + tt[2])

    remap = []
    for b in head["bones"]:
        if b["name"] in index:
            remap.append(index[b["name"]])
            continue
        parent = remap[b["parent"]] if b["parent"] >= 0 else index[root["name"]]
        gq, gt = qnorm(qmul(tq, b["gq"])), xf(b["gt"])
        pq, pt = bones[parent]["gq"], bones[parent]["gt"]
        index[b["name"]] = len(bones)
        remap.append(len(bones))
        bones.append({"name": b["name"], "parent": parent, "gq": gq, "gt": gt,
                      "lq": qnorm(qmul(qconj(pq), gq)),
                      "lt": qrot(qconj(pq), (gt[0] - pt[0], gt[1] - pt[1], gt[2] - pt[2]))})
    surfaces = list(body["surfaces"])
    for s in head["surfaces"]:
        surfaces.append(dict(s, pos=[xf(p) for p in s["pos"]],
                             nrm=[qrot(tq, n) for n in s["nrm"]],
                             weights=[[(remap[b], w) for b, w in infl]
                                      for infl in s["weights"]]))
    return surfaces, bones


def write_combined(models, outdir):
    """For each mp_body_* model, write <body>_with_head.glb using the matching head_* model."""
    def key(n):
        return ("op" if "_op_" in n else "ally", n.rsplit("_", 1)[-1])
    heads = {key(m["name"]): m for m in models if m["name"].startswith("head_")}
    for body in models:
        if not body["name"].startswith("mp_body_") or key(body["name"]) not in heads:
            continue
        head = heads[key(body["name"])]
        merged = merge_models(body, head)
        base = os.path.join(outdir, body["name"] + "_with_head")
        if not merged:
            print("could not attach %s to %s (no shared root bone)" %
                  (head["name"], body["name"]))
            continue
        write_glb(base, body["name"] + "_with_head", merged[0], merged[1], outdir)
        print("combined -> %s.glb (%d bones)" % (base, len(merged[1])))


# ---------------------------------------------------------------- animation sample dump

ASSET_TYPE_XANIM = 2
XANIM_SIZE = 0x58


def read_some(mem, addr, most=0x40000):
    """Read as much as is readable at addr, up to `most` bytes."""
    size = most
    while size >= 0x40:
        d = mem.read(addr, size)
        if d:
            return d
        size //= 2
    return None


def dump_anims_raw(mem, needle, outdir, limit=12):
    """Save the raw data of a few animations so their format can be decoded offline."""
    import json
    import zipfile
    pool = u32(mem, DB_XASSET_POOL + 4 * ASSET_TYPE_XANIM)
    count = u32(mem, G_POOL_SIZE + 4 * ASSET_TYPE_XANIM)
    print("animation pool at 0x%08X, capacity %d" % (pool, count))
    if not pool or not 0 < count < 200000:
        print("! could not find the animation pool")
        return 1
    best = {}
    for header in (0, 4):
        found = {}
        for i in range(count):
            a = pool + header + i * XANIM_SIZE
            name = cstr(mem, u32(mem, a))
            if name:
                found[a] = name
        if len(found) > len(best):
            best = found
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "anim_names.txt"), "w") as f:
        f.write("\n".join(sorted(set(best.values()))) + "\n")
    print("%d animations loaded; names saved to anim_names.txt" % len(best))
    wanted = sorted(((n, a) for a, n in best.items() if needle.lower() in n.lower()))[:limit]
    if not wanted:
        print("No loaded animation has '%s' in its name. Look in anim_names.txt and try another word." % needle)
        return 1
    index = []
    path = os.path.join(outdir, "anim_dump.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, (name, addr) in enumerate(wanted):
            head = mem.read(addr, XANIM_SIZE)
            entry = {"name": name, "addr": addr, "head": head.hex(), "blocks": {}, "bone_names": None}
            for off in range(4, XANIM_SIZE, 4):
                ptr = struct.unpack_from("<I", head, off)[0]
                if ptr < 0x10000:
                    continue
                data = read_some(mem, ptr)
                if data:
                    fname = "a%02d_off%02x.bin" % (n, off)
                    z.writestr(fname, data)
                    entry["blocks"]["%d" % off] = {"ptr": ptr, "file": fname, "size": len(data)}
            try:                                    # bone names, if the header is laid out as expected
                bones = head[26]
                ids = struct.unpack("<%dH" % bones, mem.read(struct.unpack_from("<I", head, 48)[0], bones * 2))
                entry["bone_ids"] = list(ids)
                entry["bone_names"] = bone_names(mem, ids)
            except Exception as e:
                entry["bone_names_error"] = repr(e)
            index.append(entry)
            print("  %s: %d data blocks" % (name, len(entry["blocks"])))
        z.writestr("index.json", json.dumps(index))
    print("saved %d animation samples -> %s" % (len(index), path))
    return 0


# ---------------------------------------------------------------- animation export

class AnimStreams:
    """The data streams of one XAnimParts, read with running cursors."""

    def __init__(self, mem, head):
        (self.n_byte, self.n_short, self.n_int, self.n_rbyte, self.n_rint, self.frames) = struct.unpack_from("<6H", head, 4)
        self.flags = head[16]
        self.counts = list(head[17:27])
        self.n_rshort, self.n_index = struct.unpack_from("<2I", head, 32)
        self.framerate = struct.unpack_from("<f", head, 40)[0]
        ptr = lambda off: struct.unpack_from("<I", head, off)[0]
        wide = self.frames >= 256
        want = {"byte": (52, self.n_byte), "short": (56, self.n_short * 2), "int": (60, self.n_int * 4),
                "rshort": (64, self.n_rshort * 2), "rbyte": (68, self.n_rbyte),
                "index": (76, self.n_index * (2 if wide else 1))}
        self.data, self.pos = {}, {}
        for key, (off, size) in want.items():
            d = mem.read(ptr(off), size) if size else b""
            if d is None:
                raise ValueError("%s stream not readable" % key)
            self.data[key], self.pos[key] = d, 0
        self.size = {k: v[1] for k, v in want.items()}

    def u8(self, s, n=1):
        p = self.pos[s]; self.pos[s] += n
        return list(self.data[s][p:p + n])

    def _n(self, s, n, fmt, width):
        p = self.pos[s]; self.pos[s] += n * width
        return list(struct.unpack_from("<%d%s" % (n, fmt), self.data[s], p))

    def u16(self, s, n=1): return self._n(s, n, "H", 2)
    def i16(self, s, n=1): return self._n(s, n, "h", 2)
    def f32(self, s, n=1): return self._n(s, n, "f", 4)

    def key_times(self, table_size):
        """Frame numbers for a track with table_size + 1 keys."""
        n = table_size + 1
        wide = self.frames >= 256
        if wide and table_size >= 0x40:            # long animation, large table: a lookup table to skip, indices kept apart
            self.pos["short"] += (((table_size - 1) >> 8) + 2) * 2
            return self.u16("index", n)
        return self.u16("short", n) if wide else self.u8("byte", n)


def decode_anim(st):
    """Decode every track. Returns (rot, pos): rot[i] for bone i, pos keyed by bone index. Units are the game's (inches)."""
    no_q, half, full, half_ns, full_ns, small_t, trans, trans_ns, no_t, total = st.counts
    unit = lambda q: [round(c / 32767.0, 5) for c in q]
    rot = [None] * no_q
    for kind, count in (("half", half), ("full", full)):
        for _ in range(count):
            ts = st.u16("short")[0]
            times = st.key_times(ts) if ts else [0]
            keys = [st.i16("rshort", 2 if kind == "half" else 4) for _ in times]
            rot.append({"t": times, "q": [unit([0, 0] + k if kind == "half" else k) for k in keys]})
    for _ in range(half_ns):
        rot.append({"t": [0], "q": [unit([0, 0] + st.i16("short", 2))]})
    for _ in range(full_ns):
        rot.append({"t": [0], "q": [unit(st.i16("short", 4))]})
    pos = {}
    for kind, count in (("byte", small_t), ("short", trans)):       # each translation track names its bone first
        for _ in range(count):
            bone = st.u8("byte")[0]
            ts = st.u16("short")[0]
            times = st.key_times(ts) if ts else [0]
            mn, sz = st.f32("int", 3), st.f32("int", 3)
            raw = [st.u8("rbyte", 3) if kind == "byte" else st.u16("rshort", 3) for _ in times]
            pos[bone] = {"t": times, "v": [[round(mn[k] + sz[k] * v, 4) for k, v in enumerate(p)] for p in raw]}
    for _ in range(trans_ns):
        bone = st.u8("byte")[0]
        pos[bone] = {"t": [0], "v": [[round(c, 4) for c in st.f32("int", 3)]]}
    st.u8("byte", no_t)                                              # bones that keep the model's own offset
    leftover = {k: (st.pos[k], st.size[k]) for k in st.size if st.pos[k] != st.size[k]}
    if leftover:
        raise ValueError("data did not line up %s" % leftover)
    if len(rot) != total:
        raise ValueError("bone count mismatch")
    return rot, pos


def decode_root_motion(mem, head, frames):
    """Root motion (how far and which way the whole character travels). Returns {"pos": ..., "rot": ...} or None."""
    part = struct.unpack_from("<I", head, 84)[0]
    if not part:
        return None
    ptrs = mem.read(part, 12)
    if not ptrs:
        return None
    trans_p, quat2_p, quat_p = struct.unpack("<3I", ptrs)
    wide = frames >= 256

    def times(addr, n):
        d = mem.read(addr, n * (2 if wide else 1))
        if d is None:
            raise ValueError("root motion key times not readable")
        return list(struct.unpack("<%dH" % n, d)) if wide else list(d)

    out = {}
    if trans_p:
        h = mem.read(trans_p, 32)
        size, small = struct.unpack_from("<HB", h, 0)
        if size == 0:
            out["pos"] = {"t": [0], "v": [[round(c, 4) for c in struct.unpack_from("<3f", h, 4)]]}
        else:
            mn, sz = struct.unpack_from("<3f", h, 4), struct.unpack_from("<3f", h, 16)
            n = size + 1
            width = 1 if small else 2
            raw = mem.read(struct.unpack_from("<I", h, 28)[0], n * 3 * width)
            if raw is None:
                raise ValueError("root motion positions not readable")
            vals = struct.unpack("<%d%s" % (n * 3, "B" if small else "H"), raw)
            out["pos"] = {"t": times(trans_p + 32, n),
                          "v": [[round(mn[c] + sz[c] * vals[k * 3 + c], 4) for c in range(3)] for k in range(n)]}
    for ptr, comps in ((quat2_p, 2), (quat_p, 4)):
        if not ptr or "rot" in out:
            continue
        h = mem.read(ptr, 12)
        size = struct.unpack_from("<H", h, 0)[0]
        unit = lambda q: [round(c / 32767.0, 5) for c in ([0, 0] + list(q) if comps == 2 else q)]
        if size == 0:
            out["rot"] = {"t": [0], "q": [unit(struct.unpack_from("<%dh" % comps, h, 4))]}
        else:
            n = size + 1
            raw = mem.read(struct.unpack_from("<I", h, 4)[0], n * comps * 2)
            if raw is None:
                raise ValueError("root motion rotations not readable")
            vals = struct.unpack("<%dh" % (n * comps), raw)
            out["rot"] = {"t": times(ptr + 8, n), "q": [unit(vals[k * comps:(k + 1) * comps]) for k in range(n)]}
    for track in out.values():
        t = track["t"]
        if len(t) > 1 and not (t[0] == 0 and all(b > a for a, b in zip(t, t[1:])) and t[-1] == frames):
            raise ValueError("root motion key times do not line up")
    return out or None


def loaded_anims(mem):
    pool = u32(mem, DB_XASSET_POOL + 4 * ASSET_TYPE_XANIM)
    count = u32(mem, G_POOL_SIZE + 4 * ASSET_TYPE_XANIM)
    print("animation pool at 0x%08X, capacity %d" % (pool, count))
    if not pool or not 0 < count < 200000:
        return {}
    best = {}
    for header in (0, 4):
        found = {}
        for i in range(count):
            a = pool + header + i * XANIM_SIZE
            name = cstr(mem, u32(mem, a))
            if name:
                found[a] = name
        if len(found) > len(best):
            best = found
    return best


def export_anims(mem, needle, outdir, limit=400):
    """Write each loaded animation whose name contains `needle` as <name>.anim.json."""
    import json
    anims = loaded_anims(mem)
    if not anims:
        print("! could not find the animation pool")
        return 1
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "anim_names.txt"), "w") as f:
        f.write("\n".join(sorted(set(anims.values()))) + "\n")
    print("%d animations loaded; names saved to anim_names.txt" % len(anims))
    wanted = sorted((n, a) for a, n in anims.items() if needle.lower() in n.lower())
    if not wanted:
        print("No loaded animation has '%s' in its name. Look in anim_names.txt and try another word." % needle)
        return 1
    if len(wanted) > limit:
        print("%d matches; exporting the first %d. Use a more specific word to get the rest." % (len(wanted), limit))
        wanted = wanted[:limit]
    # body animations first: their bone names pin down the name table most reliably
    wanted.sort(key=lambda w: (not w[0].startswith(("pb_", "pt_")), w[0]))
    done = unnamed = 0
    for name, addr in wanted:
        try:
            head = mem.read(addr, XANIM_SIZE)
            st = AnimStreams(mem, head)
            rot, pos = decode_anim(st)
            total = st.counts[9]
            raw = mem.read(struct.unpack_from("<I", head, 48)[0], total * 2)
            if raw is None:
                raise ValueError("bone list not readable")
            names = bone_names(mem, struct.unpack("<%dH" % total, raw))
        except Exception as e:
            print("  ! %s skipped: %s" % (name, e))
            continue
        if names and names[0].startswith("bone_"):
            unnamed += 1
        bones = []
        for i in range(total):
            b = {"name": names[i]}
            if rot[i]:
                b["rot"] = rot[i]
            if i in pos:
                b["pos"] = pos[i]
            bones.append(b)
        try:
            root = decode_root_motion(mem, head, st.frames)
        except Exception as e:
            print("  ! %s: root motion left out (%s)" % (name, e))
            root = None
        out = {"format": "cinematic-anim-1", "name": name, "frames": st.frames, "framerate": round(st.framerate, 4),
               "loop": bool(st.flags & 1), "has_root_motion": bool(root), "bones": bones}
        if root:
            out["root"] = root
        safe = name.replace("/", "_").replace("\\", "_")
        with open(os.path.join(outdir, safe + ".anim.json"), "w") as f:
            json.dump(out, f, separators=(",", ":"))
        done += 1
    print("exported %d of %d animations to %s" % (done, len(wanted), outdir))
    if unnamed:
        print("! %d animation(s) have placeholder bone names (bone_0, bone_1...). Tell Claude; those cannot be applied to a model." % unnamed)
    return 0 if done else 1


# ---------------------------------------------------------------- maps
# The loaded map's drawable geometry (GfxWorld): one big vertex and index buffer, a list of surfaces that each name
# a material and a slice of those buffers, and a list of placed static models (crates, cars, trees...).
WORLD_VERTEX_SIZE = 44      # xyz, binormal sign, colour, uv, lightmap uv, packed normal, packed tangent
WORLD_SURFACE_SIZE = 24     # layer data, first vertex, vertex count, triangle count, first index, material, 4 flags
SMODEL_INST_SIZE = 76       # origin, 3x3 axis, scale, model pointer, culling and lighting fields


def _floats_sane(data, count):
    vals = struct.unpack_from("<%df" % count, data)
    return all(v == v and abs(v) < 1e6 for v in vals)


def _world_draw_fields(mem, head):
    """Find (vertexCount, vertices, indexCount, indices) in a GfxWorld header. Expected at 120; scanned if not."""
    for off in [120] + list(range(64, 0x180, 4)):
        if off + 32 > len(head):
            break
        vcount, verts, _vb, _lsize, _ldata, _lvb, icount, inds = struct.unpack_from("<8I", head, off)
        if not (100 <= vcount <= 4000000 and 300 <= icount <= 20000000):
            continue
        probe = mem.read(verts, WORLD_VERTEX_SIZE * 8)
        if not probe or not mem.read(verts + (vcount - 1) * WORLD_VERTEX_SIZE, WORLD_VERTEX_SIZE):
            continue
        if not all(_floats_sane(probe[i * WORLD_VERTEX_SIZE:], 3) for i in range(8)):
            continue
        if not mem.read(inds, 12) or not mem.read(inds + (icount - 1) * 2, 2):
            continue
        return off, vcount, verts, icount, inds
    return None


def find_world(mem):
    """Return (address, header bytes, name) of the loaded map's GfxWorld, searching every asset pool."""
    for typ in [21] + [t for t in range(0, 48) if t != 21]:
        pool = u32(mem, DB_XASSET_POOL + 4 * typ)
        if not pool:
            continue
        for header in (0, 4):
            head = mem.read(pool + header, 0x400)
            if not head:
                continue
            name = cstr(mem, struct.unpack_from("<I", head, 0)[0])
            if not name or not name.startswith("maps/"):
                continue
            if _world_draw_fields(mem, head):
                return pool + header, head, name, typ
    return None


def _find_surfaces(mem, head, surface_count, vcount, icount):
    """The surface list is a pointer somewhere in the header; recognise it by what it points at."""
    check = min(surface_count, 48)
    for off in range(0x98, len(head) - 4, 4):
        ptr = struct.unpack_from("<I", head, off)[0]
        data = mem.read(ptr, WORLD_SURFACE_SIZE * check)
        if not data:
            continue
        good = 0
        for i in range(check):
            _layer, first, nverts, ntris, base, mat = struct.unpack_from("<IIHHII", data, i * WORLD_SURFACE_SIZE)
            if nverts and ntris and first + nverts <= vcount and base + ntris * 3 <= icount and cstr(mem, u32(mem, mat)):
                good += 1
        if good == check and mem.read(ptr + (surface_count - 1) * WORLD_SURFACE_SIZE, WORLD_SURFACE_SIZE):
            return off, ptr
    return None


def _find_static_models(mem, head, model_addrs):
    """The placed-model list: records whose model pointer is a loaded model and whose axes are unit length."""
    def valid(rec):
        if struct.unpack_from("<I", rec, 52)[0] not in model_addrs:
            return False
        vals = struct.unpack_from("<13f", rec)
        if not all(v == v and abs(v) < 1e6 for v in vals):
            return False
        return all(0.9 < sum(c * c for c in vals[3 + 3 * r:6 + 3 * r]) < 1.1 for r in range(3)) and 0.01 < vals[12] < 100

    for off in range(0x98, len(head) - 4, 4):
        ptr = struct.unpack_from("<I", head, off)[0]
        first = mem.read(ptr, SMODEL_INST_SIZE)
        if not first or not valid(first):
            continue
        out = []
        while len(out) < 60000:
            chunk = mem.read(ptr + len(out) * SMODEL_INST_SIZE, SMODEL_INST_SIZE * 256)
            if not chunk:
                chunk = mem.read(ptr + len(out) * SMODEL_INST_SIZE, SMODEL_INST_SIZE)
                if not chunk:
                    break
            stop = False
            for i in range(len(chunk) // SMODEL_INST_SIZE):
                rec = chunk[i * SMODEL_INST_SIZE:(i + 1) * SMODEL_INST_SIZE]
                if not valid(rec):
                    stop = True
                    break
                out.append(rec)
            if stop:
                break
        return off, out
    return None, []


def read_map_entities(mem):
    """The map's entity text (spawn points, triggers, and the movable models we want): a list of key/value dicts."""
    import re
    for typ in [19] + [t for t in range(0, 48) if t not in (19, 21)]:
        pool = u32(mem, DB_XASSET_POOL + 4 * typ)
        if not pool:
            continue
        for header in (0, 4):
            head = mem.read(pool + header, 16)
            if not head:
                continue
            name = cstr(mem, struct.unpack_from("<I", head, 0)[0])
            text_ptr, count = struct.unpack_from("<II", head, 4)
            if not name or not name.startswith("maps/") or not 64 < count < 8000000:
                continue
            start = mem.read(text_ptr, 16)
            if not start or not start.lstrip().startswith(b"{"):
                continue
            raw = mem.read(text_ptr, count) or b""
            text = raw.split(b"\0")[0].decode("latin-1")
            ents = []
            for block in re.findall(r"\{([^{}]*)\}", text):
                ents.append(dict(re.findall(r'"([^"]*)"\s+"([^"]*)"', block)))
            return ents, typ
    return [], None


def _angles_matrix(origin, angles, scale):
    """The game's pitch/yaw/roll (degrees) and origin as a column-major 4x4, matching the placed-model matrices."""
    import math
    pitch, yaw, roll = (math.radians(a) for a in angles)
    sp, cp, sy, cy, sr, cr = math.sin(pitch), math.cos(pitch), math.sin(yaw), math.cos(yaw), math.sin(roll), math.cos(roll)
    forward = (cp * cy, cp * sy, -sp)
    left = (sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp)
    up = (cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp)
    return [forward[0] * scale, forward[1] * scale, forward[2] * scale, 0.0, left[0] * scale, left[1] * scale, left[2] * scale, 0.0,
            up[0] * scale, up[1] * scale, up[2] * scale, 0.0, origin[0], origin[1], origin[2], 1.0]


def _unpack_normal(n):
    scale = ((n >> 24) + 192.0) / 32385.0
    return (((n & 0xFF) - 127.0) * scale, ((n >> 8 & 0xFF) - 127.0) * scale, ((n >> 16 & 0xFF) - 127.0) * scale)


def read_model_geometry(mem, addr):
    """Top-detail geometry of a model, without bones: [{material, textures, pos, nrm, uv, idx}]."""
    head = mem.read(addr, XMODEL_SIZE)
    if not head:
        return []
    mats = struct.unpack_from("<I", head, 60)[0]
    numsurfs, surfindex, model_surfs = struct.unpack_from("<HHI", head, 68)
    surfs = struct.unpack_from("<I", head, 100)[0]
    if not mem.read(surfs, XSURFACE_SIZE):
        surfs = u32(mem, model_surfs + 4)
    if not 1 <= numsurfs <= 255 or not mem.read(surfs, XSURFACE_SIZE):
        return []
    out = []
    for i in range(numsurfs):
        sd = mem.read(surfs + i * XSURFACE_SIZE, XSURFACE_SIZE)
        vert_count, tri_count = struct.unpack_from("<HH", sd, 2)
        vdata = mem.read(struct.unpack_from("<I", sd, 28)[0], vert_count * VERTEX_SIZE)
        idata = mem.read(struct.unpack_from("<I", sd, 12)[0], tri_count * 6)
        if not vdata or not idata:
            continue
        mat_ptr = u32(mem, mats + 4 * (surfindex + i))
        pos, nrm, uv = array("f"), array("f"), array("f")
        for x, y, z, _bs, _col, t, n, _tan in struct.iter_unpack("<ffffIIII", vdata):
            pos.extend((x, y, z))
            uv.extend((struct.unpack("<e", struct.pack("<H", t >> 16))[0], struct.unpack("<e", struct.pack("<H", t & 0xFFFF))[0]))
            nrm.extend(qnorm3(_unpack_normal(n)))
        idx = array("I", [k for a, b, c in struct.iter_unpack("<HHH", idata) for k in (c, b, a)])
        out.append({"material": cstr(mem, u32(mem, mat_ptr)) or "material_%d" % i, "textures": material_textures(mem, mat_ptr),
                    "pos": pos, "nrm": nrm, "uv": uv, "idx": idx, "draw": material_draw_info(mem, mat_ptr)})
    return out


def write_map_glb(path, name, world_groups, model_meshes, instances):
    """world_groups / model_meshes[name]: lists of {material, pos, nrm, uv, idx}; instances: [(model name, 16 floats)]."""
    import json
    binbuf = bytearray()
    views, accessors, materials, mat_index, meshes, nodes = [], [], [], {}, [], []

    def add(data, ctype, count, typ, target=None, minmax=None):
        binbuf.extend(b"\0" * (-len(binbuf) % 4))
        views.append({"buffer": 0, "byteOffset": len(binbuf), "byteLength": len(data)})
        if target:
            views[-1]["target"] = target
        binbuf.extend(data)
        accessors.append({"bufferView": len(views) - 1, "componentType": ctype, "count": count, "type": typ})
        if minmax:
            accessors[-1]["min"], accessors[-1]["max"] = minmax
        return len(accessors) - 1

    def primitive(g):
        n = len(g["pos"]) // 3
        mn = [min(g["pos"][k::3]) for k in range(3)]
        mx = [max(g["pos"][k::3]) for k in range(3)]
        if g["idx"].itemsize != 4:                       # index data must be 32-bit whatever this Python calls "I"
            g["idx"] = array("L" if array("L").itemsize == 4 else "I", g["idx"])
        if g["material"] not in mat_index:
            mat_index[g["material"]] = len(materials)
            materials.append({"name": g["material"], "doubleSided": True,
                              "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.9}})
        return {"attributes": {
            "POSITION": add(g["pos"].tobytes(), 5126, n, "VEC3", 34962, (mn, mx)),
            "NORMAL": add(g["nrm"].tobytes(), 5126, n, "VEC3", 34962),
            "TEXCOORD_0": add(g["uv"].tobytes(), 5126, n, "VEC2", 34962)},
            "indices": add(g["idx"].tobytes(), 5125, len(g["idx"]), "SCALAR", 34963),
            "material": mat_index[g["material"]]}

    root = {"name": name, "rotation": [-0.70710678, 0.0, 0.0, 0.70710678], "scale": [0.0254, 0.0254, 0.0254], "children": []}
    nodes.append(root)
    meshes.append({"name": name + "_world", "primitives": [primitive(g) for g in world_groups if g["idx"]]})
    nodes.append({"name": name + "_world", "mesh": 0})
    root["children"].append(1)
    mesh_of = {}
    for mname, groups in model_meshes.items():
        prims = [primitive(g) for g in groups if g["idx"]]
        if prims:
            mesh_of[mname] = len(meshes)
            meshes.append({"name": mname, "primitives": prims})
    for mname, matrix in instances:
        if mname in mesh_of:
            nodes.append({"name": mname, "mesh": mesh_of[mname], "matrix": matrix})
            root["children"].append(len(nodes) - 1)
    binbuf.extend(b"\0" * (-len(binbuf) % 4))
    gltf = {"asset": {"version": "2.0", "generator": "iw4x_rip.py"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes,
            "meshes": meshes, "materials": materials, "accessors": accessors, "bufferViews": views,
            "buffers": [{"byteLength": len(binbuf)}]}
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binbuf)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binbuf), 0x004E4942) + bytes(binbuf))


def export_map(mem, outdir, with_models=True):
    """Export the map the game currently has loaded as <map>.glb, with a texture list and a report."""
    os.makedirs(outdir, exist_ok=True)
    found = find_world(mem)
    if not found:
        print("No loaded map found. Be spawned in a match (or a private match) on the map you want, then run this again.")
        return 1
    addr, head, full_name, typ = found
    name = os.path.splitext(os.path.basename(full_name))[0]
    report = ["map %s (%s) at 0x%08X in asset pool %d" % (name, full_name, addr, typ)]
    off, vcount, verts, icount, inds = _world_draw_fields(mem, head)
    surface_count = struct.unpack_from("<I", head, 16)[0]
    report.append("draw data at +%d: %d vertices, %d indices, %d surfaces" % (off, vcount, icount, surface_count))
    sky_image = cstr(mem, u32(mem, struct.unpack_from("<I", head, off - 8)[0] + 28)) if off >= 8 else None
    report.append("sky image: %s" % sky_image)
    print("\n".join(report))

    def finish(code):
        report.append("")
        report.append(hexdump(head[:0x2C0], addr))
        with open(os.path.join(outdir, name + "_report.txt"), "w") as f:
            f.write("\n".join(report) + "\n")
        print("report: %s" % os.path.join(outdir, name + "_report.txt"))
        return code

    surf = _find_surfaces(mem, head, surface_count, vcount, icount) if 0 < surface_count < 200000 else None
    if not surf:
        report.append("! could not find the surface list (surface count %d)" % surface_count)
        print(report[-1] + " - send the report file back")
        return finish(1)
    surf_off, surf_ptr = surf
    report.append("surface list at +%d" % surf_off)
    vdata = mem.read(verts, vcount * WORLD_VERTEX_SIZE)
    idata = mem.read(inds, icount * 2)
    sdata = mem.read(surf_ptr, surface_count * WORLD_SURFACE_SIZE)
    if not vdata or not idata or not sdata:
        report.append("! could not read the vertex, index or surface data in one piece")
        print(report[-1])
        return finish(1)
    indices = array("H", idata)
    print("reading the world geometry...", flush=True)

    groups, tex_lines, seen_mats, skipped = {}, [], set(), 0
    draw_lines = []                                  # material, technique set, sort key: how each one is drawn
    mat_names = {}
    for i in range(surface_count):
        _layer, first, nverts, ntris, base, mat = struct.unpack_from("<IIHHII", sdata, i * WORLD_SURFACE_SIZE)
        if mat not in mat_names:
            mat_names[mat] = cstr(mem, u32(mem, mat)) or "material_%08x" % mat
            draw_lines.append("%s\t%s\t%d" % ((mat_names[mat],) + material_draw_info(mem, mat)))
            for semantic, image in material_textures(mem, mat):
                tex_lines.append("%s\tsemantic=%d\timages/%s.iwi" % (mat_names[mat], semantic, image))
        mname = mat_names[mat]
        if not nverts or not ntris or first + nverts > vcount or base + ntris * 3 > icount:
            skipped += 1
            continue
        if "sky" in mname.split("/")[-1].lower().split("_"):      # the sky box: the editor supplies its own sky
            continue
        g = groups.setdefault(mname, {"material": mname, "pos": array("f"), "nrm": array("f"), "uv": array("f"), "idx": array("I"), "remap": {}})
        if i and i % 2000 == 0:
            print("  surfaces %d of %d" % (i, surface_count), flush=True)
        tri = indices[base:base + ntris * 3]
        if max(tri) >= nverts:
            skipped += 1
            continue
        # Surfaces share large, overlapping stretches of the vertex buffer, so keep each vertex a material uses once.
        remap, local = g["remap"], []
        for t in tri:
            gv = first + t
            li = remap.get(gv)
            if li is None:
                li = remap[gv] = len(g["pos"]) // 3
                x, y, z, _bs, _col, u, v, _lu, _lv, n, _t = struct.unpack_from("<4fI4fII", vdata, gv * WORLD_VERTEX_SIZE)
                g["pos"].extend((x, y, z))
                g["uv"].extend((u, v))
                g["nrm"].extend(qnorm3(_unpack_normal(n)))
            local.append(li)
        for k in range(0, len(local), 3):
            g["idx"].extend((local[k + 2], local[k + 1], local[k]))
    for g in groups.values():
        del g["remap"]
    report.append("world: %d materials, %d triangles, %d vertices kept of %d, %d surfaces skipped" %
                  (len(groups), sum(len(g["idx"]) for g in groups.values()) // 3,
                   sum(len(g["pos"]) for g in groups.values()) // 3, vcount, skipped))
    print(report[-1])

    model_meshes, instances = {}, []
    if with_models:
        models = models_from_pool(mem)
        inst_off, records = _find_static_models(mem, head, set(models))
        report.append("static models: %d placed (list at +%s)" % (len(records), inst_off))
        print(report[-1])
        failed = set()
        for count, rec in enumerate(records):
            if count and count % 500 == 0:
                print("  placed models %d of %d (%d different so far)" % (count, len(records), len(model_meshes)), flush=True)
            vals = struct.unpack_from("<13f", rec)
            maddr = struct.unpack_from("<I", rec, 52)[0]
            mname = models[maddr]
            if mname not in model_meshes and mname not in failed:
                geo = read_model_geometry(mem, maddr)
                if geo:
                    model_meshes[mname] = geo
                    for g in geo:
                        if g["material"] not in seen_mats:
                            seen_mats.add(g["material"])
                            draw_lines.append("%s\t%s\t%d" % ((g["material"],) + g["draw"]))
                            for semantic, image in g["textures"]:
                                tex_lines.append("%s\tsemantic=%d\timages/%s.iwi" % (g["material"], semantic, image))
                else:
                    failed.add(mname)
            ox, oy, oz = vals[0:3]
            sc = vals[12]
            a = vals[3:12]
            instances.append((mname, [a[0] * sc, a[1] * sc, a[2] * sc, 0.0, a[3] * sc, a[4] * sc, a[5] * sc, 0.0,
                                      a[6] * sc, a[7] * sc, a[8] * sc, 0.0, ox, oy, oz, 1.0]))
        report.append("static models: %d different models read, %d could not be read%s" %
                      (len(model_meshes), len(failed), (": " + ", ".join(sorted(failed)[:20])) if failed else ""))
        print(report[-1])

        # movable objects (vehicles, destructible cars, doors, some furniture) are listed in the map's entity text
        by_name = {}
        for maddr, mname in models.items():
            by_name.setdefault(mname.lower(), maddr)
        ents, ent_pool = read_map_entities(mem)
        placed, not_loaded, classes = 0, {}, {}
        for ent in ents:
            mname = ent.get("model", "")
            if not mname or mname.startswith("*") or "origin" not in ent:
                continue
            try:
                origin = [float(v) for v in ent["origin"].split()]
                angles = [float(v) for v in ent.get("angles", "0 0 0").split()]
                scale = float(ent.get("modelscale", "1") or 1)
            except ValueError:
                continue
            if len(origin) != 3 or len(angles) != 3:
                continue
            maddr = by_name.get(mname.lower())
            if maddr is None:
                not_loaded[mname] = not_loaded.get(mname, 0) + 1
                continue
            real = models[maddr]
            if real not in model_meshes and real not in failed:
                geo = read_model_geometry(mem, maddr)
                if geo:
                    model_meshes[real] = geo
                    for g in geo:
                        if g["material"] not in seen_mats:
                            seen_mats.add(g["material"])
                            draw_lines.append("%s\t%s\t%d" % ((g["material"],) + g["draw"]))
                            for semantic, image in g["textures"]:
                                tex_lines.append("%s\tsemantic=%d\timages/%s.iwi" % (g["material"], semantic, image))
                else:
                    failed.add(real)
            if real in model_meshes:
                instances.append((real, _angles_matrix(origin, angles, scale)))
                placed += 1
                cls = ent.get("classname", "?")
                classes[cls] = classes.get(cls, 0) + 1
        report.append("movable objects: %d entities in the map (pool %s), %d placed %s" % (len(ents), ent_pool, placed, classes))
        if not_loaded:
            report.append("movable objects whose model is not loaded right now (%d): %s" %
                          (sum(not_loaded.values()), ", ".join("%s x%d" % kv for kv in sorted(not_loaded.items())[:40])))
        print("\n".join(report[-2:] if not_loaded else report[-1:]))

    path = os.path.join(outdir, name + ".glb")
    print("writing the file...", flush=True)
    write_map_glb(path, name, list(groups.values()), model_meshes, instances)
    with open(os.path.join(outdir, name + "_textures.txt"), "w") as f:
        f.write("\n".join(tex_lines) + "\n")
    with open(os.path.join(outdir, name + "_materials.txt"), "w") as f:
        f.write("\n".join(draw_lines) + "\n")
    if UNREAD_IMAGES:
        report.append("images whose name could not be read (%d): %s" % (len(UNREAD_IMAGES), "; ".join(
            "%s sem %d @0x%08X" % u for u in UNREAD_IMAGES[:40])))
    report.append("wrote %s (%.1f MB) and %s_textures.txt (%d texture lines)" %
                  (path, os.path.getsize(path) / 1e6, name, len(tex_lines)))
    print(report[-1])
    print("Next: run iw4x_textures.py to pull this map's textures, then use Import map in the app.")
    return finish(0)



def run(mem, needle, list_only, outdir, swap_uv):
    models = models_from_pool(mem)
    print("%d models found in pool" % len(models))
    if list_only:
        for n in sorted(set(models.values())):
            print(n)
        return 0
    wanted = {a: n for a, n in models.items() if needle.lower() in n.lower()}
    if not wanted:
        wanted = models_from_scan(mem, needle)
    if not wanted:
        print("No loaded model has '%s' in its name. Make sure you are spawned in a "
              "match with that model visible, or try --list." % needle)
        return 1
    done = {}
    # bodies first: their skeleton pins down the bone-name table most reliably
    order = sorted(wanted.items(), key=lambda kv: (not kv[1].startswith("mp_body_"), kv[1]))
    for addr, name in order:
        print("%s @ 0x%08X" % (name, addr))
        model = export_model(mem, addr, name, outdir, swap_uv)
        if model:
            done[name] = model
    print("exported %d of %d models" % (len(done), len(set(wanted.values()))))
    write_combined(list(done.values()), outdir)
    return 0 if done else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="?", default="ghillie",
                    help="substring of the model name (default: ghillie)")
    ap.add_argument("--list", action="store_true", help="list loaded model names")
    ap.add_argument("--swap-uv", action="store_true", help="swap U and V")
    ap.add_argument("--out", default="ripped", help="output folder")
    ap.add_argument("--anims", metavar="WORD", help="export animations whose name contains WORD as .anim.json files")
    ap.add_argument("--map", action="store_true", help="export the map the game has loaded right now (geometry and placed models)")
    ap.add_argument("--map-no-models", action="store_true", help="with --map: leave out the placed models (crates, cars, trees)")
    ap.add_argument("--anims-raw", metavar="WORD", help="save undecoded samples of a few animations, for debugging")
    args = ap.parse_args()
    if os.name != "nt":
        sys.exit("This must be run on the Windows PC where the game is running.")
    pid, exe = find_pid()
    if not pid:
        sys.exit("Game not running. Looked for: " + ", ".join(PROCESS_NAMES))
    print("attached to %s (pid %d)" % (exe, pid))
    if args.map or args.map_no_models:
        sys.exit(export_map(ProcessMemory(pid), args.out, not args.map_no_models))
    if args.anims is not None:
        sys.exit(export_anims(ProcessMemory(pid), args.anims, args.out))
    if args.anims_raw is not None:
        sys.exit(dump_anims_raw(ProcessMemory(pid), args.anims_raw, args.out))
    sys.exit(run(ProcessMemory(pid), args.name, args.list, args.out, args.swap_uv))


if __name__ == "__main__":
    main()
