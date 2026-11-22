#!/usr/bin/env python3
"""
iw4x_textures.py - pull the textures used by models ripped with iw4x_rip.py
out of the game's .iwd archives, convert them to .dds, and wire them into the .mtl files.

Usage:
    python iw4x_textures.py --ripped "%USERPROFILE%\\Desktop\\ripped"
    python iw4x_textures.py --ripped <folder> --game "D:\\Steam\\steamapps\\common\\Call of Duty Modern Warfare 2"

The game folder is auto-detected from the running game or common Steam paths if --game is omitted.
"""
import argparse
import glob
import os
import struct
import sys
import zipfile

FOURCC = {0x0B: b"DXT1", 0x0C: b"DXT3", 0x0D: b"DXT5"}
BLOCK = {0x0B: 8, 0x0C: 16, 0x0D: 16}
RAW = {0x01: (32, 0x41, 0xFF000000), 0x02: (24, 0x40, 0)}   # bits, pf flags, alpha mask
SEM_COLOR, SEM_NORMAL, SEM_SPEC = 2, 5, 8


def iwi_to_dds(data, face=0, want_faces=None):
    """Convert IWI bytes to DDS bytes (top mip only). Raises ValueError if unsupported.
    A sky is six images in one file: `face` picks which one; `want_faces` (a list) receives how many there are."""
    if data[:3] != b"IWi":
        raise ValueError("not an IWI file")
    version = data[3]
    fmt_off, header = (8, 32) if version >= 8 else (4, 28)
    fmt = data[fmt_off]
    usage = data[fmt_off + 1]
    w, h, _d = struct.unpack_from("<HHH", data, fmt_off + 2)
    if not (0 < w <= 8192 and 0 < h <= 8192):
        raise ValueError("bad size %dx%d (iwi v%d)" % (w, h, version))
    if fmt in FOURCC:
        size = max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * BLOCK[fmt]
        pf = struct.pack("<II4sIIIII", 32, 0x4, FOURCC[fmt], 0, 0, 0, 0, 0)
        flags = 0x1007 | 0x80000
        pitch = size
    elif fmt in RAW:
        bits, pfflags, amask = RAW[fmt]
        size = w * h * bits // 8
        pf = struct.pack("<II4sIIIII", 32, pfflags, b"\0\0\0\0", bits,
                         0x00FF0000, 0x0000FF00, 0x000000FF, amask)
        flags = 0x1007 | 0x8
        pitch = w * bits // 8
    else:
        raise ValueError("unsupported IWI format 0x%02X (v%d, usage %d)" % (fmt, version, usage))
    faces = 6 if usage & 0x4 and len(data) - header >= size * 6 else 1
    if len(data) - header < size:
        raise ValueError("file too small for %dx%d fmt 0x%02X" % (w, h, fmt))
    if want_faces is not None:
        want_faces.append(faces)
    top = data[-size * faces:][size * min(face, faces - 1):][:size]      # mips are stored smallest first; take the largest
    head = struct.pack("<4sIIIIIII44x", b"DDS ", 124, flags, h, w, pitch, 0, 0)
    head += pf + struct.pack("<IIIII", 0x1000, 0, 0, 0, 0)
    assert len(head) == 128
    return head + top


def find_game_dir():
    """Best effort: path of the running game, else common Steam install paths."""
    candidates = []
    if os.name == "nt":
        try:
            import ctypes
            import subprocess
            from ctypes import wintypes
            out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True,
                                 text=True).stdout
            k32 = ctypes.WinDLL("kernel32")
            k32.OpenProcess.restype = wintypes.HANDLE
            k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k32.QueryFullProcessImageNameW.argtypes = [
                wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                ctypes.POINTER(wintypes.DWORD)]
            for line in out.splitlines():
                parts = [p.strip('"') for p in line.split('","')]
                if len(parts) >= 2 and parts[0].lower() in ("iw4x.exe", "iw4mp.exe", "iw4m.exe"):
                    h = k32.OpenProcess(0x1000, False, int(parts[1]))
                    buf = ctypes.create_unicode_buffer(1024)
                    n = wintypes.DWORD(1024)
                    if h and k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                        candidates.append(os.path.dirname(buf.value))
        except Exception:
            pass
        for drive in "CDEFG":
            for lib in (r"Program Files (x86)\Steam", "Steam", "SteamLibrary",
                        r"Games\Steam", r"Games\SteamLibrary"):
                candidates.append(r"%s:\%s\steamapps\common\Call of Duty Modern Warfare 2"
                                  % (drive, lib))
    for c in candidates:
        if glob.glob(os.path.join(c, "main", "*.iwd")):
            return c
    return None


def index_iwds(game_dir):
    """Map lowercased 'images/x.iwi' -> (iwd path, member name); later archives win."""
    index = {}
    iwds = sorted(glob.glob(os.path.join(game_dir, "main", "*.iwd")))
    for path in iwds:
        try:
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    low = name.lower()
                    if low.startswith("images/") and low.endswith(".iwi"):
                        index[low] = (path, name)
        except zipfile.BadZipFile:
            print("  skipping unreadable archive %s" % os.path.basename(path))
    print("indexed %d images from %d .iwd archives" % (len(index), len(iwds)))
    return index


def pick(entries, semantic, suffixes):
    for sem, img in entries:
        if sem == semantic:
            return img
    for _sem, img in entries:
        if img.lower().endswith(suffixes):
            return img
    return None


def process(ripped, game_dir):
    index = index_iwds(game_dir)
    texdir = os.path.join(ripped, "textures")
    os.makedirs(texdir, exist_ok=True)
    converted, missing, failed = {}, set(), {}
    lists = glob.glob(os.path.join(ripped, "*_textures.txt"))
    if not lists:
        print("no *_textures.txt files in %s - run iw4x_rip.py first" % ripped)
        return 1
    open_zips = {}
    for listing in lists:
        materials = {}
        with open(listing) as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) != 3:
                    continue
                mat, sem, img = parts
                materials.setdefault(mat, []).append((int(sem.split("=")[1]), img))
        for entries in materials.values():
            # a sky is six separate images; the material only names the front one, so fetch its five partners too
            for _sem, img in list(entries):
                if img.lower().endswith("_ft.iwi"):
                    entries.extend((_sem, img[:-7] + side + ".iwi") for side in ("_bk", "_lf", "_rt", "_up", "_dn"))
        for entries in materials.values():
            for _sem, img in entries:
                key = img.lower()
                if key in converted or key in missing or key in failed:
                    continue
                if key not in index:
                    missing.add(key)
                    continue
                path, member = index[key]
                z = open_zips.get(path) or open_zips.setdefault(path, zipfile.ZipFile(path))
                out = os.path.splitext(os.path.basename(member))[0] + ".dds"
                try:
                    raw, count = z.read(member), []
                    dds = iwi_to_dds(raw, 0, count)
                    if count and count[0] == 6:           # a sky box: also write each of its six sides
                        for face in range(6):
                            with open(os.path.join(texdir, "%s.face%d.dds" % (os.path.splitext(out)[0], face)), "wb") as o:
                                o.write(iwi_to_dds(raw, face))
                        print("sky box %s: six sides written" % out)
                except ValueError as e:
                    failed[key] = str(e)
                    continue
                with open(os.path.join(texdir, out), "wb") as o:
                    o.write(dds)
                converted[key] = "textures/" + out
        # rewrite the .mtl so the OBJ picks the textures up
        mtl = listing[:-len("_textures.txt")] + ".mtl"
        lines = []
        for mat, entries in materials.items():
            lines.append("newmtl %s\nKd 0.8 0.8 0.8" % mat)
            for key, sem, suffixes in (("map_Kd", SEM_COLOR, ("_col", "_c", "_color")),
                                       ("map_Bump", SEM_NORMAL, ("_nml", "_n", "_normal")),
                                       ("map_Ks", SEM_SPEC, ("_spc", "_s", "_spec"))):
                img = pick(entries, sem, suffixes)
                if img and img.lower() in converted:
                    lines.append("%s %s" % (key, converted[img.lower()]))
            lines.append("")
        with open(mtl, "w") as f:
            f.write("\n".join(lines))
    print("converted %d textures into %s" % (len(converted), texdir))
    if missing:
        print("%d not found in any .iwd (stored inside fastfiles instead):" % len(missing))
        for m in sorted(missing):
            print("   " + m)
    for k, why in sorted(failed.items()):
        print("   could not convert %s: %s" % (k, why))
    return 0 if converted else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ripped", default="ripped", help="folder iw4x_rip.py exported into")
    ap.add_argument("--game", help="MW2 install folder (the one containing 'main')")
    args = ap.parse_args()
    game = args.game or find_game_dir()
    if not game or not glob.glob(os.path.join(game, "main", "*.iwd")):
        sys.exit("Could not find the game folder. Pass it with --game \"<path to MW2 folder>\".")
    print("game folder: %s" % game)
    sys.exit(process(args.ripped, game))


if __name__ == "__main__":
    main()
