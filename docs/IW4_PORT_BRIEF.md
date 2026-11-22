# Brief: add Modern Warfare 2 (IW4x) support to T6Iris

This is a starting brief for a session running on the owner's Windows PC. It was written in a cloud session that
could read the code but could not build it or run the game. Statements marked **verify** were not confirmed.

## Goal

The owner makes trickshot montages ("teamtages") on MW2 2009 through the IW4x client and wants an in-game movie
editor: free camera, keyframed camera paths, bone-mounted cameras, depth of field, lighting and colour control,
and recording, using the game's own renderer. A friend's tool does this for Black Ops 2. The job is to add an
MW2 module to it.

The first target is deliberately small: **the tool loads into IW4x, its menu opens, and a free camera works
during demo playback.** Prove that before building anything else.

## The starting code

- **T6Iris**, GPL-3.0: `https://github.com/SonderEnterprises/T6Iris`. Clone it with `--recursive`; the copy in the
  owner's Google Drive has empty submodule folders and will not build.
- It is a fork of Iris Studio (Black Ops 1), itself a fork of **IWXMVM** by reallyluckyy
  (`https://github.com/reallyluckyy/IWXMVM`). Upstream IWXMVM targets Call of Duty 4 (IW3), which is a much closer
  engine to IW4 than Black Ops 2 is. **Verify** what upstream has, and whether anyone has already published an IW4
  module, before writing one from nothing.
- Layout:
  - `core/`: game-neutral static library, about 98,000 lines (UI, timeline, cameras, keyframes, capture, D3D9 and
    D3D11 renderers, hook, patch and signature utilities).
  - `core/src/GameInterface.hpp`: the contract each game implements. 84 virtual methods, 31 pure virtual, plus
    `GetSupportedFeatures()` flags that let a game opt out of UI it cannot support yet.
  - `core/src/Types/Game.hpp`: `enum class Game { None, IW3, IW5, T5, T6 }`. There is no IW4 entry.
  - `t6/src/`: the Black Ops 2 module, 27 files, about 9,100 lines: `Signatures.hpp` (63 byte patterns),
    `Structures.hpp`, `T6Interface.hpp`, `Theater.cpp`, `Camera.cpp`, `Bones.cpp`, `Lights.cpp`, `Filmtweaks.cpp`,
    `Props.cpp`. Read it as the worked example of a module; none of its addresses or Theater logic apply to IW4.
  - `t5/`: the Black Ops 1 module (D3D9, which IW4 also uses). Useful for the D3D9 path.
- Build: Visual Studio 2022 solution `IWXMVM.sln`, MSBuild, C++20, **32-bit only**, needs the DirectX SDK
  (June 2010) with `DXSDK_DIR` set. No CMake.

## What an IW4 module needs

A new `iw4/` project that implements `GameInterface`, with its own entry point, signatures, structures and hooks,
linking `core/` and using the D3D9 renderer.

Differences from the Black Ops 2 module to plan for:

- **Graphics:** D3D9, not D3D11.
- **Playback:** IW4 uses classic demo files recorded with the client, not Treyarch's Theater with snapshots.
  Rewind and seek work differently; check how upstream IWXMVM handles IW3 demos.
- **Loading:** T6Iris loads as a plugin of the Redacted client. IW4x has no such loader that this brief can
  confirm. The repository has `tools/injector` (used for the Black Ops 1 build). **Verify** the right way to load a
  DLL into `iw4x.exe`.
- **Engine structures:** dvars, refdef, entities and client state all differ.

## What is already known about IW4x memory

From the ripper in this repository (`tools/iw4x_rip.py`), confirmed against the owner's game (process
`iw4x.exe`, 32-bit, MW2 1.2.159):

- Asset pool table `DB_XAssetPool` at `0x7998A8`, pool sizes at `0x7995E8`.
- Asset type indices: xanim 2, xmodel 4, map entities 19, world geometry (GfxWorld) 21.
- Struct sizes: XModel `0x130`, XSurface `0x40`, packed model vertex 32 bytes, XAnimParts `0x58`, world vertex
  44 bytes, world surface 24 bytes, placed static model 76 bytes.
- GfxWorld: surface count at `+16`, vertex and index data at `+120`; on Derail the surface list pointer was at
  `+540` and the static model list at `+548`.
- Material: name pointer at `+0`, sort key at `+5`, texture count at `+72`, technique set pointer at `+80`,
  texture table at `+84`.
- The XAnim format is fully decoded in `tools/iw4x_rip.py` (see `decode_anim` and `decode_root_motion`).

These cover assets, not the camera, input, dvars or demo playback, which is what the first milestone needs.
The IW4x client is open source and documents many function and variable addresses for this exact executable;
**verify** the current repository location and use it as the primary reference rather than rediscovering
addresses by hand.

## Milestones

1. **Build what exists.** Clone recursively, build the `t6` target unchanged. This proves the toolchain.
2. **Empty IW4 module that loads.** Add `IW4` to the game enum, create `iw4/`, get the DLL into `iw4x.exe`, hook
   the D3D9 present or end-scene call, and show the ImGui menu. Mark every feature unsupported.
3. **Free camera in demo playback.** Find the view definition (origin, angles, field of view) and override it
   while a demo plays. Add pause and timescale through dvars or console commands.
4. **Camera paths.** The keyframe and timeline code is in `core/`; it needs the camera override and a notion of
   demo time.
5. **Then, in the owner's order of priority:** bone camera, depth of field, sun, fog and colour controls,
   recording, placed actors.

Stop and report after each milestone. Do not start the next one until the owner has seen the last one work.

## How to work with the owner

- They are not a programmer. They have used Cinema 4D and Blender. Give exact commands and click paths, one step
  at a time, and say what they should see.
- You cannot see the game. They launch IW4x, start a private match or a demo, and report or screenshot what
  happens. Add logging (the project uses spdlog) and read the log file yourself rather than asking them to
  describe errors.
- **Private matches, demos and offline only.** Never load the tool in a public lobby. Say so again whenever it
  matters.
- They were frustrated by slow round trips and tools that were hard to use. Prefer small steps that visibly
  work over large ones that might.
- State plainly what was tested and what was not. Do not claim something works until it has run in their game.

## Licence

T6Iris is GPL-3.0. Any distributed version of the port must stay GPL-3.0 with source available, keep the
existing copyright and credit notices, and credit IWXMVM, Iris Studio and T6Iris. Do not bundle game assets.

## What already exists and still has value

- This repository: a browser-based cinematic editor plus the ripping scripts. It is not being abandoned, but it is
  not the route for final renders.
- The owner's `library` folder holds rips from their own game: the arctic and urban ghillie characters (rigged),
  the Intervention in nine camos, the map Derail with its placed models, and two animations. These are not in any
  repository and must not be added to one.
- The opener they are making: Kyger's round-winning Search and Destroy trickshot on Derail. Arctic ghillie with
  the ghillie hat, Fall camo Intervention. The intro they want: he runs through the ground-floor garage of the
  dark corrugated building by the red tanks, up two flights of stairs with cuts between a gun-mounted camera and
  a head camera, out onto the lower roof, then a bird's-eye shot that pushes in and cuts to the gameplay clip.
  A project file for this blocking exists in the browser app (`derail_opener_cuts.json`, sent to the owner).
