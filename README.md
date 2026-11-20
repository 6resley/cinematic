# Cinematic

A focused editor for making custom 3D cinematics with models, weapons and animations from IW4x.
It keeps only what a cinematic needs: a viewport, a camera you can keyframe, a timeline, scene lighting, and a renderer.

**No game files live in this repository.** The app ships empty. Each person imports models ripped from their own copy of the game.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open the address it prints (normally http://127.0.0.1:5173).

## What works today (milestone 1)

- **Two view modes**, toggled with <kbd>Tab</kbd>:
  - **Camera** looks through the shot camera in a 16:9 frame. Drag to look, <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>Q</kbd> <kbd>E</kbd> to fly, wheel to dolly.
  - **Free** orbits around the scene. The shot camera, its path and its keyframes are drawn in 3D, with a live preview of the shot in the corner.
- **Camera keyframes**: <kbd>K</kbd> sets a key at the playhead. Drag the diamonds on the timeline to retime. Each key has an ease (auto, linear, smooth, hold). Auto-key records a key whenever you move the camera.
- **Timeline**: scrub, play (<kbd>Space</kbd>), step frames (<kbd>←</kbd> <kbd>→</kbd>, with <kbd>Shift</kbd> for ten), markers (<kbd>M</kbd>), adjustable length and frame rate.
- **Lens**: focal length and roll, both keyframed with the camera.
- **Animations**: import `.anim.json` files exported by the ripper and play one on the character, with start time, speed and repeat. The game's 30 fps animations are blended between keys, so they stay smooth at 60, 120 or 240 fps. Poses you set are stored as offsets on top of the playing animation, so you can turn the head or lift an arm while the run carries on underneath.
- **Camera mounts**: make the camera ride on any bone of an imported character (weapon hand, head, foot), optionally staying aimed at another bone and optionally keeping the horizon level. Four presets: Gun cam, Helmet cam, Over shoulder, Boot cam. Keys set while mounted are remembered relative to the mount.
- **Scene**: time of day, sun heading, exposure, fog.
- **Move things**: select an item in the Scene list, then in Free mode press <kbd>W</kbd> to move or <kbd>E</kbd> to rotate.
- **Test render**: renders the frame at the playhead at up to 3840 × 2160 into a viewer, with Save PNG (<kbd>Shift</kbd>+<kbd>R</kbd>).
- **Import model**: pick the folder holding a `.glb` and its textures. Files are read locally and never uploaded. A folder straight from the ripper works as it is: the app reads `<model>_textures.txt` and the `.dds` files itself, including the game's normal and specular maps. If the folder holds several models you are asked which one.
- **Props**: Import prop adds a second model, such as a weapon, attached to a bone of the character (the weapon hand by default) so it moves with the animation. A weapon model contains every attachment at once, so each part has a checkbox; scopes, suppressors and similar extras start hidden.
- **Projects**: Save and Open as a `.json` file, plus an automatic restore of your last session.

Until you import a model, a plain stand-in figure marks where the character goes.

## The assistant

The **Assistant** tab lets you describe what you want in plain words ("slow push-in on the face over 4 seconds, at dusk", "raise his right arm and curl the fingers") and have it done for you. It works by operating the editor's own controls: reading the scene, keying the camera, setting sky and light, moving the actor, posing bones on an imported rigged model, and taking pictures of the result to check its work.

- It runs on Claude through the Anthropic API, so it needs your own API key. Open **API key** in the tab, paste it and press Save.
- The key is stored only in your browser on your computer and is sent only to Anthropic. It is never written into project files.
- Each request uses API credit on your account.
- **Undo assistant changes** puts the project back to how it was before its last request.

## Not built yet

Render queue for whole shots, several animation clips in sequence, keyframed bone poses (pose offsets are static for now), root motion, asset library, weapons and camos, weather, look presets, depth of field and motion blur, undo/redo, and a packaged desktop build.

## Development

```bash
npm test
```

runs the keyframe interpolation tests.

```bash
npm run build
```

makes a production build in `dist/`.
