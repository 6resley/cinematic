# Cinematic

A focused editor for making custom 3D cinematics with models, weapons and animations from IW4x.
It keeps only what a cinematic needs: a viewport, a camera you can keyframe, a timeline, scene lighting, and a renderer.

**No game files live in this repository.** The app ships empty. Each person imports models ripped from their own copy of the game.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

On Windows, double-click `Cinematic.bat`: it installs what is needed the first time, starts the app and opens it in your browser. Keep its window open while you work. Or do the same by hand:

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
- **Animations**: import `.anim.json` files exported by the ripper and play one on the character, with start time, speed and repeat. The game's 30 fps animations are blended between keys, so they stay smooth at 60, 120 or 240 fps. Poses you set are stored as offsets on top of the playing animation, so you can turn the head or lift an arm while the run carries on underneath. With **Travel** on, the animation also carries the character across the scene the way it does in the game (a sprint covers about 11 m per cycle and keeps going each repeat); with it off he stays on the spot. **Keep hands and feet above the ground** bends an arm or leg just enough when the game's animation would sink it into the flat floor (the hand at the end of a death, for example). **Then play** chains a second animation that takes over at a time you choose, with a blend between the two (a death after a sprint); it continues from wherever the first has carried him. **Add another clip** carries the chain on with as many more as you like (sprint, slide, death).
- **Poses over time**: in the Scene tab pick a bone and turn it with the handle in the viewport (Free mode), then press **Key pose** (<kbd>P</kbd>). Key a different pose at another time and he eases from one to the other while the animation keeps playing underneath: a head turn mid-sprint, an arm coming up. Pose keys show as green diamonds on the timeline; click to jump there, Shift-click to delete.
- **Camera mounts**: make the camera ride on any bone of an imported character (weapon hand, head, foot), optionally staying aimed at another bone and optionally keeping the horizon level. **Smoothing** lets the camera trail the bone a little, which takes the harsh shake out of a gun or helmet cam. Presets: **Side rail cam** (clamped to the side of the barrel, tilted, looking back up at him past the out-of-focus gun, with depth of field set on his head), **Gun cam** (fixed to the muzzle of the attached weapon, looking back down the barrel at him), **Barrel POV** (fixed on the weapon, looking where the barrel points), Helmet cam, Over shoulder and Boot cam. The gun presets find the barrel from the weapon model, so import the weapon as a prop first. Keys set while mounted are remembered relative to the mount.
- **Look**: the finish of the picture, in the Scene tab. Presets (**Noir with red**, **Gritty night**, **Golden hour**) set glow on bright areas, soft contact shadowing, a film grade (colour, contrast, vignette, grain, keep-the-reds), a rim light from behind, a fill light from the camera side and dark wet ground; every part has its own slider. It shows in Camera mode, test renders and the queue. The sky is a gradient with a glowing sun, and shadows follow the character wherever the animation carries him. This is a real-time renderer, not a path tracer: for the most realistic light, load a 360° sky image (free ones at polyhaven.com/hdris).
- **Scene**: time of day, sun heading, exposure, fog, and weather (rain, heavy rain, snow, dust) that streaks properly with motion blur. **Sky image** loads a 360° panorama (`.hdr`, `.jpg`, `.png`) as the sky and as light on the character; it is not stored in the project file, so load it again after reopening.
- **Move things**: select an item in the Scene list, then in Free mode press <kbd>W</kbd> to move or <kbd>E</kbd> to rotate.
- **Render queue**: add shots as jobs, each with its own time range, resolution (up to 3840 × 2160), frame rate (24 to 240), motion blur and output: an H.264 MP4, or a numbered PNG sequence written to a folder you pick. Frames are rendered one at a time at their exact moment, so the result is smooth at any frame rate regardless of how fast the computer is. Motion blur averages several sub-frames per frame.
- **Depth of field**: in the Camera tab, raise Blur and choose what stays sharp: a bone (the focus follows it, such as the head) or a set distance. **Key focus** at two times makes a focus pull that eases from one to the other. It shows in test renders and the render queue, not the live view.
- **Passes for the editor**: a PNG-sequence job can render on a transparent background (the character alone, ready to lay over gameplay) and can also write a depth pass (`<name>_depth_00001.png`: white near the camera, black at the depth range you set), which an editor can use for fog, glows or extra blur.
- **The queue is saved with the project** and with the automatic restore. A PNG-sequence job that was stopped, or cut off by a crash, picks up at the frame it reached (choose the same folder); ↻ on a stopped job queues it again.
- **Test render**: renders the frame at the playhead at up to 3840 × 2160 into a viewer, with Save PNG (<kbd>Shift</kbd>+<kbd>R</kbd>).
- **Import model**: pick the folder holding a `.glb` and its textures. Files are read locally and never uploaded. A folder straight from the ripper works as it is: the app reads `<model>_textures.txt` and the `.dds` files itself, including the game's normal and specular maps. If the folder holds several models you are asked which one.
- **Library**: copy your ripped folders (characters, weapons, maps, `.anim.json` files) into the `library` folder next to the app, and they appear in **Character**, **Weapon** and **Map** drop-downs at the top left; animations load by themselves. A project remembers which ones it used, so opening it, or reopening the app, brings the models, map and animations back without any importing. The folder stays on your computer and is never part of the repository. Press **Rescan** after adding files.
- **Maps**: Import map loads an environment exported with the ripper's `--map` option (the map's geometry plus its placed models), with its textures read from the same folder. The built-in ground is hidden, shadows fall on the map, and **Place actor here** stands the character on whatever the middle of the view is pointing at. Like models, maps are not stored in the project file: import the folder again after reopening.
- **Props**: Import prop adds a second model, such as a weapon, attached to a bone of the character (the weapon hand by default) so it moves with the animation. A weapon model contains every attachment at once, so each part has a checkbox; scopes, suppressors and similar extras start hidden. Camo variants of a weapon load with their camo painted on.
- **Undo and redo**: <kbd>Ctrl</kbd>+<kbd>Z</kbd> and <kbd>Ctrl</kbd>+<kbd>Y</kbd> (or the arrows in the top bar) step back and forward through your changes: camera keys, poses, mounts, lighting, animation settings.
- **Projects**: Save and Open as a `.json` file, plus an automatic restore of your last session.

Until you import a model, a plain stand-in figure marks where the character goes.

## The assistant

The **Assistant** tab lets you describe what you want in plain words ("slow push-in on the face over 4 seconds, at dusk", "raise his right arm and curl the fingers") and have it done for you. It works by operating the editor's own controls: reading the scene, keying the camera, setting sky and light, moving the actor, posing bones on an imported rigged model, and taking pictures of the result to check its work.

- It runs on Claude through the Anthropic API, so it needs your own API key. Open **API key** in the tab, paste it and press Save.
- The key is stored only in your browser on your computer and is sent only to Anthropic. It is never written into project files.
- Each request uses API credit on your account.
- **Undo assistant changes** puts the project back to how it was before its last request.

## Not built yet

Asset library, map environments, motion-vector passes, and a packaged desktop build.

## Development

```bash
npm test
```

runs the keyframe interpolation tests.

```bash
npm run build
```

makes a production build in `dist/`.
