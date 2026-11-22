# IW4x memory findings (from the ripper)

Everything here was worked out while building `tools/iw4x_rip.py` and confirmed by reading the owner's running
game from outside the process: `iw4x.exe`, 32-bit, MW2 1.2.159, Windows. The script is the executable form of
these notes; where they disagree, trust the script.

**Scope.** These findings cover assets: models, skeletons, animations, materials, the map and its entities.
They say nothing about the camera, view definition, input, dvars, console, demo playback or the renderer's
present call. Those are what the port's first milestone needs and they still have to be found.

**Confidence.** "Confirmed" means it produced correct output on the owner's game (a model that looks right, an
animation that plays right, the map Derail). "Observed once" means seen on one asset or one map only.

## Reading the process

- All addresses are absolute virtual addresses in the 32-bit process. The image is not relocated in practice;
  the fixed addresses below worked on every run.
- Reads were done with `ReadProcessMemory` from an Administrator prompt. An in-process module can read the same
  addresses directly.

## Asset pools (confirmed)

| What | Address |
| --- | --- |
| `DB_XAssetPool`: table of pool pointers, one per asset type | `0x7998A8` |
| Pool capacities, one `uint32` per asset type | `0x7995E8` |

Pool pointer for a type is `*(uint32*)(0x7998A8 + 4 * type)`.

Asset type indices confirmed by use:

| Type | Index |
| --- | --- |
| xanim (XAnimParts) | 2 |
| xmodel | 4 |
| map entities (MapEnts) | 19 |
| world geometry (GfxWorld) | 21 |

A pool is an array of fixed-size entries. An entry may or may not be preceded by a 4-byte free-list link; the
script tries both header offsets 0 and 4 and keeps whichever yields more valid names. A live entry starts with a
pointer to its name string.

## Names and the script-string table (confirmed)

- Asset names are plain NUL-terminated ASCII at the pointer in the first field.
- Bone names are script-string ids (`uint16`), not pointers. The string for id `n` is at
  `base + 12 * n + 4`. The script locates `base` at run time by searching for known bone names
  (`tag_origin`, `j_mainroot`, `j_spine4`, `j_head`, `j_neck`) and accepting a base only if at least 80% of a
  skeleton's names start with `j_`, `tag_`, `bi_`, `pelvis`, `torso_` or `back_`. A wrong base still returns
  valid-looking strings from a shifted slot, so that plausibility check is necessary.
- Not resolved: weapon and viewmodel skeletons came out with shuffled bone names (correct names present but in
  the wrong order). Body skeletons were correct.

## XModel (confirmed), entry size `0x130`

| Offset | Field |
| --- | --- |
| `+0` | name pointer |
| `+4` | bone count (`uint8`) |
| `+60` | pointer to the material handle array |
| `+68` | LOD 0: surface count (`uint16`), first surface index (`uint16`), model-surfaces pointer |
| `+100` | pointer to the LOD 0 XSurface array (if unreadable, use `*(modelSurfs + 4)`) |

Heads are separate models positioned relative to `j_spine4` of the body; the script merges body and head.

### XSurface (confirmed), size `0x40`

| Offset | Field |
| --- | --- |
| `+2` | vertex count (`uint16`), triangle count (`uint16`) |
| `+12` | pointer to triangle indices, 3 `uint16` each |
| `+28` | pointer to packed vertices |

Triangles are wound clockwise-front (Direct3D convention).

### Packed model vertex (confirmed), 32 bytes

`float xyz[3]`, `float binormalSign`, `uint32 colour`, `uint32 texCoord`, `uint32 normal`, `uint32 tangent`.

- `texCoord` is two half floats: high 16 bits then low 16 bits.
- `normal` and `tangent` are packed unit vectors: for packed value `n`,
  `scale = ((n >> 24) + 192) / 32385`, component `i` is `(((n >> 8*i) & 0xFF) - 127) * scale`.

Units are inches, Z up. Multiply by 0.0254 and rotate -90 degrees about X for metres, Y up.

## Material (confirmed)

| Offset | Field |
| --- | --- |
| `+0` | name pointer |
| `+5` | sort key (`uint8`) |
| `+72` | texture count (`uint8`) |
| `+80` | technique set pointer; the technique set's name pointer is at its `+0` |
| `+84` | texture table pointer |

Texture table entries are 12 bytes: semantic at byte `+7`, GfxImage pointer at `+8`. The image's name pointer
was found at image `+28` (the script also tries `+24`, `+32`, `+20`).

Semantics seen: 2 colour map, 5 normal map, 8 specular map, 3 detail map (on painted weapons this slot holds the
camo pattern, named `weapon_camo_*`).

Technique set names encode how a material is drawn. The pattern `_r0c0`, `_t0c0`, `_b0c0`, `_a0c0` was taken to
mean replace (solid), alpha test (cut-out), blend, and additive. This mapping is an inference that has not been
checked against the game on a full map.

Texture conventions (confirmed on characters and weapons):

- Normal maps store X in alpha and Y in green.
- Specular map alpha is gloss.
- A weapon colour map's alpha is the paint mask; the camo is multiplied in as
  `base * (1 + (2 * camo - 1) * mask)`, tiled about 4 times.
- Twelve world materials on Derail returned no colour map through this reader (chain-link fences, one brick
  wall, some tree materials). Cause not found.

## XAnimParts (confirmed, 48 of 48 samples decoded exactly), entry size `0x58`

Header:

| Offset | Field |
| --- | --- |
| `+0` | name pointer |
| `+4` | six `uint16`: dataByteCount, dataShortCount, dataIntCount, randomDataByteCount, randomDataIntCount, numframes |
| `+16` | flags; bit 0 is loop |
| `+17` | `boneCount[10]` as `uint8`: noQuat, halfQuat, fullQuat, halfQuatNoSize, fullQuatNoSize, smallTrans, trans, transNoSize, noTrans, total. Total bone count is at `+26` |
| `+32` | randomDataShortCount |
| `+36` | indexCount |
| `+40` | framerate (`float`) |
| `+48` | names pointer (script-string ids) |
| `+52` | dataByte, `+56` dataShort, `+60` dataInt, `+64` randomDataShort, `+68` randomDataByte, `+72` randomDataInt, `+76` indices, `+80` notify, `+84` deltaPart |

Decoding rules that mattered:

- Rotations come in bone-type order with no bone index. Half quats are 2 shorts (z, w), full quats 4 shorts, all
  divided by 32767.
- Each translation track starts with a bone-index byte. Small translations are `min + size * uint8`, full ones
  `min + size * uint16`.
- Key tables hold `tableSize + 1` entries covering frames 0 to numframes inclusive. Large tables (64 or more
  entries) use the index stream only when numframes is 256 or more.
- **Animated positions are offsets added to the model's bind-pose bone offset, not replacements.**

Root motion (`deltaPart`): a struct of three pointers `{trans, quat2, quat}`.

- Translation part: `uint16 size`, `uint8 smallTrans`, mins at `+4`, size vector at `+16`, frames pointer at
  `+28`, indices at `+32`. A size of 0 means a single value stored at `+4`.
- Rotation part (`quat2`): `uint16 size`, frames pointer at `+4`, indices at `+8`.

`pb_sprint` on the ghillie body: 120 animated bones, loops, travels 10.9 m per 1.53 s pass.

## GfxWorld (confirmed on Derail), found in pool 21

| Offset | Field |
| --- | --- |
| `+0` | name pointer, for example `maps/mp/mp_derail.d3dbsp` |
| `+16` | surface count |
| `+20` | sky count, `+24` skies pointer (not parsed) |
| `+80` | reflection probe count; `+96` lightmap count |
| `+112` | sky image pointer: was null at run time on Derail |
| `+120` | vertex count, `+124` vertex data pointer |
| `+144` | index count, `+148` index data pointer (`uint16`) |

The surface list and static-model list sit further into the struct. The script finds them by scanning for a
pointer whose target validates, rather than trusting an offset. On Derail they were at `+540` (surfaces) and
`+548` (static models). Observed once.

- World vertex, 44 bytes: `float xyz[3]`, `float binormalSign`, `uint32 colour`, `float texCoord[2]`,
  `float lightmapCoord[2]`, `uint32 normal`, `uint32 tangent` (normals packed as for models).
- World surface, 24 bytes: `uint32 vertexLayerData`, `uint32 firstVertex`, `uint16 vertexCount`,
  `uint16 triCount`, `uint32 baseIndex`, `uint32 material`, then four flag bytes. Indices are relative to
  `firstVertex`.
- Surfaces share large, overlapping ranges of the vertex buffer. Copying a range per surface exhausts memory;
  deduplicate by vertex index.
- Static model instance, 76 bytes: `float origin[3]`, `float axis[3][3]`, `float scale`, XModel pointer at `+52`,
  then culling and lighting fields. The axis rows are forward, left, up. Derail has 7,954 instances of 249
  models, all placed correctly with this layout.

Derail's sky material is `wc/sky_sp_cliffhanger`, image `sky_sp_cliffhanger_ft`. The sky is believed to be six
separate images (`_ft`, `_bk`, `_lf`, `_rt`, `_up`, `_dn`); not confirmed.

## MapEnts (not yet run on the real game), expected in pool 19

Name pointer at `+0`, entity string pointer at `+4`, character count at `+8`. The string is the usual
`{ "key" "value" ... }` blocks. Movable models are entries with a `model` key that does not start with `*`,
plus `origin`, optional `angles` (pitch, yaw, roll in degrees) and `modelscale`. The parser was tested only
against a synthetic memory image.

## Game files on disk (confirmed)

- Textures are `.iwi` files inside the `.iwd` archives in the game's `main` folder (zip format,
  `images/<name>.iwi`). All 855 textures Derail needed were found there; none had to come from fastfiles.
- IWI: magic `IWi`, version byte; for version 8 the format byte is at offset 8 and the header is 32 bytes.
  Formats `0x0B`, `0x0C`, `0x0D` are DXT1, DXT3, DXT5. Mip levels are stored smallest first, so the largest is
  at the end of the file. Format `0x07` (seen on two textures) is not decoded.
