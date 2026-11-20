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
- **Scene**: time of day, sun heading, exposure, fog.
- **Move things**: select an item in the Scene list, then in Free mode press <kbd>W</kbd> to move or <kbd>E</kbd> to rotate.
- **Test render**: renders the frame at the playhead at up to 3840 × 2160 into a viewer, with Save PNG (<kbd>Shift</kbd>+<kbd>R</kbd>).
- **Import model**: pick the folder holding a `.glb` and its textures. Files are read locally and never uploaded.
- **Projects**: Save and Open as a `.json` file, plus an automatic restore of your last session.

Until you import a model, a plain stand-in figure marks where the character goes.

## Not built yet

Render queue for whole shots, animation clips and layered bone overrides, asset library, weapons and camos, weather, look presets, depth of field and motion blur, undo/redo, and a packaged desktop build.

## Development

```bash
npm test
```

runs the keyframe interpolation tests.

```bash
npm run build
```

makes a production build in `dist/`.
