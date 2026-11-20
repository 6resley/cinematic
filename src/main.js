import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CameraTrack, EASE_MODES } from './keys.js';
import { FlyLook } from './flylook.js';
import { toLocal, toWorld, reframeKeys, bodyAxes } from './mount.js';
import { createClient, runTurn, describeError, MODEL } from './assistant.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
const SHOT_ASPECT = 16 / 9;
const SENSOR_HALF = 12;                       // half of a 24 mm sensor height
const fovFromFocal = (mm) => THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_HALF / mm));
const focalFromFov = (fov) => SENSOR_HALF / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
const AUTOSAVE_KEY = 'cinematic.autosave.v1';

// ------------------------------------------------------------------ state
const defaults = () => ({
  duration: 10, fps: 60, time: 0, loop: false, autoKey: false,
  markers: [],
  mount: { bone: null, lookAt: null, level: false, roll: 0 },   // what the shot camera rides on
  pose: {},                                   // bone name -> local rotation, for bones moved off the imported pose
  scene: { tod: 15, azimuth: 60, exposure: 1, fog: 0, grid: true },
});
const state = defaults();
let track = new CameraTrack();
let mode = 'free';
let playing = false;
let camDirty = false;                         // camera moved by hand but not keyed yet
let selectedKey = null;
let selectedActor = null;

// ------------------------------------------------------------------ three
const canvas = $('canvas');
const viewEl = $('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x30302c, 0.8);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 60 });
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.02;
scene.add(hemi, sun, sun.target);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x8d9094, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
const grid = new THREE.GridHelper(40, 40, 0x6a7078, 0x4a4f56);
grid.position.y = 0.002;
scene.add(ground, grid);

const actorRoot = new THREE.Group();
actorRoot.name = 'Stand-in figure';
scene.add(actorRoot);

function buildStandIn() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.7 });
  const part = (geo, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  part(new THREE.CapsuleGeometry(0.19, 0.42, 6, 16), 0, 1.22, 0);            // torso
  part(new THREE.SphereGeometry(0.115, 20, 16), 0, 1.69, 0);                 // head
  part(new THREE.CapsuleGeometry(0.075, 0.62, 4, 12), -0.11, 0.48, 0);       // legs
  part(new THREE.CapsuleGeometry(0.075, 0.62, 4, 12), 0.11, 0.48, 0);
  part(new THREE.CapsuleGeometry(0.055, 0.5, 4, 12), -0.3, 1.18, 0).rotation.z = -0.12;   // arms
  part(new THREE.CapsuleGeometry(0.055, 0.5, 4, 12), 0.3, 1.18, 0).rotation.z = 0.12;
  const nose = part(new THREE.ConeGeometry(0.03, 0.08, 10), 0, 1.69, 0.13);  // shows which way it faces
  nose.rotation.x = Math.PI / 2;
  return g;
}
actorRoot.add(buildStandIn());

const shotCam = new THREE.PerspectiveCamera(fovFromFocal(35), SHOT_ASPECT, 0.05, 800);
const freeCam = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
const camHelper = new THREE.CameraHelper(shotCam);
const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe8a13a }));
const keyDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xf2c26b, size: 9, sizeAttenuation: false }));
pathLine.frustumCulled = keyDots.frustumCulled = false;
const mountGroup = new THREE.Group();            // follows the mount, so the path is drawn where the camera will ride
mountGroup.add(pathLine, keyDots);
scene.add(shotCam, camHelper, mountGroup);
const camLocal = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };   // camera pose relative to its mount
const mountFrame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

function resetCameras() {
  shotCam.position.set(2.6, 1.5, 3.4);
  shotCam.lookAt(0, 1.1, 0);
  shotCam.fov = fovFromFocal(35);
  shotCam.updateProjectionMatrix();
  camLocal.position.copy(shotCam.position);     // nothing is mounted after a reset, so local and world agree
  camLocal.quaternion.copy(shotCam.quaternion);
  freeCam.position.set(6.5, 4.2, 7.5);
  orbit.target.set(0, 1, 0);
  orbit.update();
}

const orbit = new OrbitControls(freeCam, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
const gizmo = new TransformControls(freeCam, canvas);
gizmo.setSize(0.8);
scene.add(gizmo);
gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value && mode === 'free'; });
gizmo.addEventListener('objectChange', () => {
  if (gizmo.object === shotCam) cameraEdited(); else scheduleAutosave();
});
const fly = new FlyLook(canvas, () => cameraEdited());
fly.camera = shotCam;
resetCameras();

// ------------------------------------------------------------------ skeleton and pose
let bones = {};
const bindPose = new Map();

function collectBones() {
  bones = {};
  bindPose.clear();
  actorRoot.traverse((o) => {
    if (o.isBone && !bones[o.name]) { bones[o.name] = o; bindPose.set(o.name, o.quaternion.toArray()); }
  });
}

/** Put every bone back to its imported rotation, then apply the saved pose on top. */
function applyPose() {
  for (const [name, q] of bindPose) bones[name].quaternion.fromArray(q);
  for (const [name, q] of Object.entries(state.pose)) if (bones[name]) bones[name].quaternion.fromArray(q);
}

const _pa = new THREE.Vector3(), _pb = new THREE.Vector3();
const _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion();

function worldRotate(bone, delta) {
  actorRoot.updateMatrixWorld(true);
  bone.getWorldQuaternion(_wq);
  bone.parent.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(delta.multiply(_wq)));
}

function boneAxis(bone, childName) {
  const child = childName ? bones[childName] : bone.children.find((c) => c.isBone);
  if (!child) throw new Error(`"${bone.name}" has no child bone to aim with; pass "child"`);
  actorRoot.updateMatrixWorld(true);
  bone.getWorldPosition(_pa);
  child.getWorldPosition(_pb);
  const axis = _pb.clone().sub(_pa);
  if (axis.lengthSq() < 1e-12) throw new Error(`"${bone.name}" and "${child.name}" are at the same place`);
  return axis.normalize();
}

function poseBone(op) {
  const bone = bones[op.bone];
  if (!bone) throw new Error(`No bone named "${op.bone}"`);
  if (op.op === 'aim') {
    const dir = new THREE.Vector3(...vec3In(op.direction, 'direction'));
    if (dir.lengthSq() < 1e-12) throw new Error('direction must not be zero');
    worldRotate(bone, new THREE.Quaternion().setFromUnitVectors(boneAxis(bone, op.child), dir.normalize()));
  } else if (op.op === 'twist') {
    worldRotate(bone, new THREE.Quaternion().setFromAxisAngle(boneAxis(bone, op.child), THREE.MathUtils.degToRad(numIn(op.degrees, 'degrees', -360, 360))));
  } else if (op.op === 'rotate') {
    const d = vec3In(op.degrees, 'degrees').map(THREE.MathUtils.degToRad);
    bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(d[0], d[1], d[2], 'XYZ')));
  } else {
    throw new Error(`Unknown operation "${op.op}"`);
  }
  state.pose[bone.name] = bone.quaternion.toArray();
}

function numIn(v, name, lo = -Infinity, hi = Infinity) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return clamp(v, lo, hi);
}
function vec3In(v, name) {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new Error(`${name} must be three numbers`);
  return v;
}

// ------------------------------------------------------------------ scene look
const NIGHT = new THREE.Color(0x0a0f1c), HORIZON = new THREE.Color(0xd98f5c), DAY = new THREE.Color(0x7fa9d6);
const SUN_LOW = new THREE.Color(0xffa860), SUN_HIGH = new THREE.Color(0xfff4e6), MOON = new THREE.Color(0x9bb8ff);
const sky = new THREE.Color();
scene.background = sky;

function applyScene() {
  const s = state.scene;
  const e = Math.sin(((s.tod - 6) / 12) * Math.PI);           // sun height: 0 at 06:00 and 18:00, 1 at noon
  if (e <= -0.12) sky.copy(NIGHT);
  else if (e < 0.03) sky.copy(NIGHT).lerp(HORIZON, (e + 0.12) / 0.15);      // dusk and dawn glow
  else if (e < 0.22) sky.copy(HORIZON).lerp(DAY, (e - 0.03) / 0.19);
  else sky.copy(DAY);
  const twilight = clamp(1 - Math.abs(e) / 0.14, 0, 1);       // soft light around sunrise and sunset
  const night = e <= -0.12;
  const el = Math.asin(clamp(Math.abs(e), 0.08, 1));
  const az = THREE.MathUtils.degToRad(s.azimuth + (night ? 180 : 0));
  sun.position.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(25);
  if (night) { sun.color.copy(MOON); sun.intensity = 1.1; }
  else { sun.color.copy(SUN_LOW).lerp(SUN_HIGH, clamp(e * 1.6, 0, 1)); sun.intensity = 3.2 * Math.pow(Math.max(e, 0), 0.6) + 0.9 * twilight; }
  hemi.intensity = 0.3 + 0.6 * Math.max(0, e) + 0.35 * twilight;
  renderer.toneMappingExposure = s.exposure;
  scene.fog = s.fog > 0 ? new THREE.FogExp2(sky.getHex(), s.fog) : null;
  grid.visible = s.grid;
}

// ------------------------------------------------------------------ time and camera track
const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 0 };
const snap = (t) => Math.round(t * state.fps) / state.fps;

function setTime(t) {
  state.time = clamp(snap(t), 0, state.duration);
  camDirty = false;
  updatePlayhead();
}

const lookAtActive = () => !!(state.mount.lookAt && bones[state.mount.lookAt]);

/** Work out where the mount is right now. With nothing mounted the frame is the world itself. */
function updateFrame() {
  const bone = state.mount.bone && bones[state.mount.bone];
  if (!bone) { mountFrame.position.set(0, 0, 0); mountFrame.quaternion.identity(); return; }
  actorRoot.updateMatrixWorld(true);
  bone.getWorldPosition(mountFrame.position);
  if (state.mount.level) mountFrame.quaternion.identity();      // ride the position only, keep the horizon level
  else bone.getWorldQuaternion(mountFrame.quaternion);
}

/** The camera was placed in world space; remember that placement relative to the mount. */
function syncLocalFromWorld() {
  updateFrame();
  toLocal(mountFrame, shotCam, camLocal);
}

function applyTrack() {
  updateFrame();
  if (!camDirty && track.evaluate(state.time, pose)) {
    camLocal.position.copy(pose.position);
    camLocal.quaternion.copy(pose.quaternion);
    if (shotCam.fov !== pose.fov) { shotCam.fov = pose.fov; shotCam.updateProjectionMatrix(); }
  }
  toWorld(mountFrame, camLocal, shotCam);
  const target = state.mount.lookAt && bones[state.mount.lookAt];
  if (target) {                                                  // stay locked on a bone; the horizon is level unless a roll is set
    shotCam.lookAt(target.getWorldPosition(_pa));
    euler.setFromQuaternion(shotCam.quaternion, 'YXZ');
    euler.z = THREE.MathUtils.degToRad(state.mount.roll || 0);
    shotCam.quaternion.setFromEuler(euler);
  }
  mountGroup.position.copy(mountFrame.position);
  mountGroup.quaternion.copy(mountFrame.quaternion);
}

function setKeyNow() {
  selectedKey = track.setKey(state.time, { position: camLocal.position, quaternion: camLocal.quaternion, fov: shotCam.fov });
  camDirty = false;
  keysChanged();
}

/** Change what the camera rides on without moving the camera or its path right now. */
function setMount(next) {
  updateFrame();
  const old = { position: mountFrame.position.clone(), quaternion: mountFrame.quaternion.clone() };
  const world = toWorld(old, camLocal, { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() });
  Object.assign(state.mount, next);
  if (state.mount.bone && !bones[state.mount.bone]) state.mount.bone = null;
  if (state.mount.lookAt && !bones[state.mount.lookAt]) state.mount.lookAt = null;
  updateFrame();
  reframeKeys(track.keys, old, mountFrame);
  toLocal(mountFrame, world, camLocal);
  keysChanged();
  syncMountUI();
}

const MOUNT_PRESETS = {
  gun: { label: 'Gun cam', bones: ['tag_weapon_right', 'j_gun', 'j_wrist_ri'], lookAt: 'j_head', level: false, focal: 16, offset: [0.55, 0.10, 0.05] },
  helmet: { label: 'Helmet cam', bones: ['j_head'], lookAt: null, level: false, focal: 18, offset: [0.25, 0.08, 0] },   // just in front of the face, clear of a hood
  shoulder: { label: 'Over shoulder', bones: ['j_spine4', 'j_spineupper'], lookAt: null, level: true, focal: 28, offset: [-0.5, 0.22, 0.28] },
  boot: { label: 'Boot cam', bones: ['j_ankle_ri', 'j_ball_ri'], lookAt: 'j_head', level: true, focal: 14, offset: [0.45, 0.04, 0.2] },
};

/** Mount the camera with a ready-made placement. offset is [forward, up, right] in metres from the mount. */
function applyMountPreset(id) {
  const preset = MOUNT_PRESETS[id];
  if (!preset) throw new Error(`Unknown mount preset "${id}"`);
  const bone = preset.bones.find((b) => bones[b]);
  const left = bones.j_shoulder_le || bones.j_clavicle_le, right = bones.j_shoulder_ri || bones.j_clavicle_ri;
  if (!bone || !left || !right) throw new Error('This model does not have the bones that preset needs. Import a rigged character first.');
  actorRoot.updateMatrixWorld(true);
  const ax = bodyAxes(left.getWorldPosition(new THREE.Vector3()), right.getWorldPosition(new THREE.Vector3()));
  setMount({ bone, lookAt: preset.lookAt && bones[preset.lookAt] ? preset.lookAt : null, level: preset.level, roll: 0 });
  const at = bones[bone].getWorldPosition(new THREE.Vector3());
  shotCam.position.copy(at).addScaledVector(ax.forward, preset.offset[0]).addScaledVector(ax.up, preset.offset[1]).addScaledVector(ax.right, preset.offset[2]);
  shotCam.position.y = Math.max(shotCam.position.y, 0.05);
  const aim = state.mount.lookAt ? bones[state.mount.lookAt].getWorldPosition(new THREE.Vector3()) : shotCam.position.clone().addScaledVector(ax.forward, 5).addScaledVector(ax.up, -0.2);
  shotCam.lookAt(aim);
  shotCam.fov = fovFromFocal(preset.focal);
  cameraEdited();
  return preset.label;
}

function deleteSelectedKey() {
  if (!selectedKey || !track.removeKey(selectedKey)) return;
  selectedKey = null;
  keysChanged();
}

/** The shot camera was moved by the user (fly, lens, gizmo). */
function cameraEdited() {
  syncLocalFromWorld();
  shotCam.updateProjectionMatrix();
  if (state.autoKey) setKeyNow();
  else { camDirty = track.keys.length > 0; scheduleAutosave(); }
}

function keysChanged() {
  const pts = track.samplePath();
  pathLine.geometry.dispose();
  pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  keyDots.geometry.dispose();
  keyDots.geometry = new THREE.BufferGeometry().setFromPoints(track.keys.map((k) => new THREE.Vector3().fromArray(k.pos)));
  rebuildKeys();
  syncKeyUI();
  scheduleAutosave();
}

// ------------------------------------------------------------------ view modes
function setMode(next) {
  mode = next;
  orbit.enabled = mode === 'free';
  fly.setEnabled(mode === 'camera');
  $('mode-camera').classList.toggle('active', mode === 'camera');
  $('mode-free').classList.toggle('active', mode === 'free');
  $('mode-camera').setAttribute('aria-selected', mode === 'camera');
  $('mode-free').setAttribute('aria-selected', mode === 'free');
  $('view-label').textContent = mode === 'camera' ? 'Shot camera' : 'Free view';
  $('view-label').classList.toggle('camera', mode === 'camera');
  $('view-hint').textContent = mode === 'camera'
    ? 'Drag to look · W A S D Q E to fly · wheel to dolly · K sets a key · Tab for free view'
    : 'Drag to orbit · right-drag to pan · wheel to zoom · Tab to look through the camera';
  attachGizmo();
}

function attachGizmo() {
  const target = mode === 'free' && selectedActor ? selectedActor.object : null;
  if (target) gizmo.attach(target); else gizmo.detach();
}

const actors = [
  { id: 'camera', name: 'Shot camera', kind: 'camera', object: shotCam },
  { id: 'actor', name: 'Stand-in figure', kind: 'model', object: actorRoot },
  { id: 'sun', name: 'Sun', kind: 'light', object: null },
];

function rebuildActors() {
  const ul = $('actor-list');
  ul.replaceChildren(...actors.map((a) => {
    const li = document.createElement('li');
    li.textContent = a.name;
    const small = document.createElement('small');
    small.textContent = a.kind;
    li.append(small);
    li.classList.toggle('selected', a === selectedActor);
    li.addEventListener('click', () => selectActor(a === selectedActor ? null : a.id));
    return li;
  }));
}

function selectActor(id) {
  selectedActor = actors.find((a) => a.id === id) || null;
  if (selectedActor?.kind === 'light') showTab('scene');
  if (selectedActor?.kind === 'camera') showTab('camera');
  rebuildActors();
  attachGizmo();
}

// ------------------------------------------------------------------ rendering
function viewSize() { return { w: Math.max(1, viewEl.clientWidth), h: Math.max(1, viewEl.clientHeight) }; }

function resize() {
  const { w, h } = viewSize();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  freeCam.aspect = w / h;
  freeCam.updateProjectionMatrix();
  drawRuler();
  rebuildKeys();
  rebuildMarkers();
  updatePlayhead();
}

const overlays = [camHelper, pathLine, keyDots];
function setOverlays(on) {
  for (const o of overlays) o.visible = on;
  gizmo.visible = on && !!gizmo.object;
  grid.visible = on && state.scene.grid;
}

/** Largest 16:9 box centred in the viewport, in CSS pixels. */
function shotRect() {
  const { w, h } = viewSize();
  let rw = w, rh = w / SHOT_ASPECT;
  if (rh > h) { rh = h; rw = h * SHOT_ASPECT; }
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
}

function drawThroughShotCam(x, y, w, h, withGrid) {
  shotCam.aspect = SHOT_ASPECT;
  shotCam.updateProjectionMatrix();
  setOverlays(false);
  grid.visible = withGrid && state.scene.grid;
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.render(scene, shotCam);
  setOverlays(true);
}

function draw() {
  const { w, h } = viewSize();
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);
  if (mode === 'camera') {
    renderer.setClearColor(0x0b0c0e, 1);
    renderer.clear();
    const r = shotRect();
    drawThroughShotCam(r.x, r.y, r.w, r.h, true);
  } else {
    camHelper.update();
    renderer.render(scene, freeCam);
    const pw = Math.min(320, w * 0.32), ph = pw / SHOT_ASPECT;      // picture-in-picture of the shot
    drawThroughShotCam(w - pw - 10, 10, pw, ph, false);
  }
}

/** Render the current frame through the shot camera at full size. Returns a PNG blob. */
async function renderStill(width, height) {
  const started = performance.now();
  applyTrack();
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setScissorTest(false);
  shotCam.aspect = width / height;
  shotCam.updateProjectionMatrix();
  setOverlays(false);
  renderer.setViewport(0, 0, width, height);
  renderer.render(scene, shotCam);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  setOverlays(true);
  resize();
  draw();
  return { blob, ms: performance.now() - started };
}

let viewerUrl = null;
async function renderCurrentFrame() {
  const [w, h] = $('rnd-size').value.split('x').map(Number);
  if (playing) { playing = false; syncPlayButton(); setTime(state.time); }
  setStatus('Rendering…');
  const { blob, ms } = await renderStill(w, h);
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(blob);
  const frame = Math.round(state.time * state.fps);
  $('viewer-img').src = viewerUrl;
  $('viewer-save').href = viewerUrl;
  $('viewer-save').download = `cinematic_f${String(frame).padStart(4, '0')}.png`;
  $('viewer-info').textContent = `${w} × ${h} · frame ${frame} · ${(ms / 1000).toFixed(2)} s`;
  $('viewer').hidden = false;
  setStatus('');
}

// ------------------------------------------------------------------ timeline
const TL_PAD = 14;
const tracksEl = $('tl-tracks');
const tlWidth = () => Math.max(1, tracksEl.clientWidth);
const xOf = (t) => TL_PAD + (t / state.duration) * (tlWidth() - 2 * TL_PAD);
const tOf = (x) => ((x - TL_PAD) / (tlWidth() - 2 * TL_PAD)) * state.duration;
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

function drawRuler() {
  const c = $('tl-ruler'), dpr = window.devicePixelRatio || 1, w = tlWidth();
  c.width = w * dpr; c.height = 22 * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, 22);
  const pxPerSec = (w - 2 * TL_PAD) / state.duration;
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s * pxPerSec >= 56) || 120;
  g.font = '11px system-ui, sans-serif';
  g.fillStyle = '#8b939e'; g.strokeStyle = '#4a515b';
  for (let t = 0; t <= state.duration + 1e-6; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    g.beginPath(); g.moveTo(x, 13); g.lineTo(x, 22); g.stroke();
    g.fillText(step < 1 ? t.toFixed(1) : fmt(t).replace(/\.00$/, ''), x + 3, 11);
  }
}

function updatePlayhead() {
  $('tl-playhead').style.left = `${xOf(state.time)}px`;
  $('tl-time').textContent = `${fmt(state.time)} / ${fmt(state.duration)} · frame ${Math.round(state.time * state.fps)}`;
}

function dragOn(el, onMove, onEnd) {
  const move = (e) => onMove(e.clientX - tracksEl.getBoundingClientRect().left);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onEnd?.(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function rebuildKeys() {
  const row = $('tl-camera');
  row.replaceChildren(...track.keys.map((k) => {
    const d = document.createElement('div');
    d.className = 'tl-key' + (k === selectedKey ? ' selected' : '');
    d.style.left = `${xOf(k.t)}px`;
    d.title = `Camera key at ${fmt(k.t)} — drag to retime`;
    d.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectedKey = k;
      setTime(k.t);
      rebuildKeys(); syncKeyUI();
      dragOn(d, (x) => {
        const t = clamp(snap(tOf(x)), 0, state.duration);
        if (track.retime(k, t)) { d.style.left = `${xOf(t)}px`; setTime(t); }
      }, keysChanged);
    });
    return d;
  }));
}

function rebuildMarkers() {
  $('tl-markers').replaceChildren(...state.markers.map((m) => {
    const d = document.createElement('div');
    d.className = 'tl-marker';
    d.style.left = `${xOf(m.t)}px`;
    d.textContent = m.label;
    d.title = 'Click to jump · double-click to rename · Shift-click to delete';
    d.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.addEventListener('click', (e) => {
      if (e.shiftKey) { state.markers.splice(state.markers.indexOf(m), 1); rebuildMarkers(); scheduleAutosave(); }
      else setTime(m.t);
    });
    d.addEventListener('dblclick', () => {
      const label = window.prompt('Marker name', m.label);
      if (label) { m.label = label; rebuildMarkers(); scheduleAutosave(); }
    });
    return d;
  }));
}

function addMarker() {
  if (state.markers.some((m) => Math.abs(m.t - state.time) < 1e-4)) return;
  state.markers.push({ t: state.time, label: `Marker ${state.markers.length + 1}` });
  state.markers.sort((a, b) => a.t - b.t);
  rebuildMarkers();
  scheduleAutosave();
}

tracksEl.addEventListener('pointerdown', (e) => {
  const x = e.clientX - tracksEl.getBoundingClientRect().left;
  playing = false; syncPlayButton();
  setTime(tOf(x));
  dragOn(tracksEl, (mx) => setTime(tOf(mx)));
});

// ------------------------------------------------------------------ inspector
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'assistant') $('ai-log').scrollTop = $('ai-log').scrollHeight;      // show the newest message
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

const euler = new THREE.Euler(0, 0, 0, 'YXZ');
function bindRange(id, read, write, format) {
  const input = $(id), out = $(`${id}-out`);
  input.addEventListener('input', () => { write(parseFloat(input.value)); out.textContent = format(parseFloat(input.value)); });
  return () => { const v = read(); if (document.activeElement !== input) input.value = v; out.textContent = format(v); };
}
const syncers = [
  bindRange('cam-focal', () => focalFromFov(shotCam.fov), (v) => { shotCam.fov = fovFromFocal(v); cameraEdited(); }, (v) => `${Math.round(v)} mm`),
  bindRange('cam-roll', () => (lookAtActive() ? state.mount.roll || 0 : THREE.MathUtils.radToDeg(euler.setFromQuaternion(shotCam.quaternion, 'YXZ').z)),
    (v) => {
      if (lookAtActive()) { state.mount.roll = v; scheduleAutosave(); return; }
      euler.setFromQuaternion(shotCam.quaternion, 'YXZ'); euler.z = THREE.MathUtils.degToRad(v); shotCam.quaternion.setFromEuler(euler); cameraEdited();
    },
    (v) => `${v.toFixed(1)}°`),
  bindRange('scn-tod', () => state.scene.tod, (v) => { state.scene.tod = v; applyScene(); scheduleAutosave(); },
    (v) => `${String(Math.floor(v) % 24).padStart(2, '0')}:${String(Math.round((v % 1) * 60) % 60).padStart(2, '0')}`),
  bindRange('scn-azimuth', () => state.scene.azimuth, (v) => { state.scene.azimuth = v; applyScene(); scheduleAutosave(); }, (v) => `${Math.round(v)}°`),
  bindRange('scn-exposure', () => state.scene.exposure, (v) => { state.scene.exposure = v; applyScene(); scheduleAutosave(); }, (v) => v.toFixed(2)),
  bindRange('scn-fog', () => state.scene.fog, (v) => { state.scene.fog = v; applyScene(); scheduleAutosave(); }, (v) => (v === 0 ? 'off' : v.toFixed(3))),
];
function syncInspector() {
  for (const s of syncers) s();
  const p = shotCam.position;
  $('cam-readout').textContent = `Position ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} m` + (camDirty ? ' · moved, not keyed' : '');
}

$('key-ease').replaceChildren(...EASE_MODES.map((m) => new Option(m, m)));
$('key-ease').addEventListener('change', () => { if (selectedKey) { selectedKey.ease = $('key-ease').value; keysChanged(); } });
function syncKeyUI() {
  $('key-ease').disabled = $('btn-del-key').disabled = !selectedKey;
  if (selectedKey) $('key-ease').value = selectedKey.ease;
  $('cam-autokey').checked = state.autoKey;
  $('scn-grid').checked = state.scene.grid;
  $('tl-duration').value = state.duration;
  $('tl-fps').value = state.fps;
  $('tl-loop').checked = state.loop;
}

function syncMountUI() {
  const names = Object.keys(bones).sort();
  for (const [id, value] of [['cam-mount', state.mount.bone], ['cam-lookat', state.mount.lookAt]]) {
    const sel = $(id);
    sel.replaceChildren(new Option(names.length ? 'None' : 'None (import a rigged model)', ''), ...names.map((n) => new Option(n, n)));
    sel.value = value && bones[value] ? value : '';
    sel.disabled = !names.length;
  }
  $('cam-level').checked = state.mount.level;
  document.querySelectorAll('[data-mount-preset]').forEach((b) => { b.disabled = !names.length; });
}
$('cam-mount').addEventListener('change', (e) => setMount({ bone: e.target.value || null }));
$('cam-lookat').addEventListener('change', (e) => setMount({ lookAt: e.target.value || null }));
$('cam-level').addEventListener('change', (e) => setMount({ level: e.target.checked }));
document.querySelectorAll('[data-mount-preset]').forEach((b) => b.addEventListener('click', () => {
  try { setStatus(`${applyMountPreset(b.dataset.mountPreset)} set`); } catch (err) { setStatus(err.message); }
}));

$('btn-key').addEventListener('click', setKeyNow);
$('btn-del-key').addEventListener('click', deleteSelectedKey);
$('cam-autokey').addEventListener('change', (e) => { state.autoKey = e.target.checked; scheduleAutosave(); });
$('scn-grid').addEventListener('change', (e) => { state.scene.grid = e.target.checked; applyScene(); scheduleAutosave(); });
$('btn-cam-to-view').addEventListener('click', () => {
  shotCam.position.copy(freeCam.position);
  shotCam.quaternion.copy(freeCam.quaternion);
  cameraEdited();
});
$('btn-view-to-cam').addEventListener('click', () => {
  freeCam.position.copy(shotCam.position);
  orbit.target.copy(shotCam.position).add(new THREE.Vector3(0, 0, -3).applyQuaternion(shotCam.quaternion));
  orbit.update();
});
$('btn-render').addEventListener('click', renderCurrentFrame);
$('viewer-close').addEventListener('click', () => { $('viewer').hidden = true; });
$('mode-camera').addEventListener('click', () => setMode('camera'));
$('mode-free').addEventListener('click', () => setMode('free'));

// ------------------------------------------------------------------ transport
function syncPlayButton() { $('tl-play').textContent = playing ? '⏸' : '▶'; }
function togglePlay() {
  if (!playing && state.time >= state.duration) setTime(0);
  playing = !playing;
  syncPlayButton();
}
$('tl-play').addEventListener('click', togglePlay);
$('tl-start').addEventListener('click', () => setTime(0));
$('tl-marker').addEventListener('click', addMarker);
$('tl-loop').addEventListener('change', (e) => { state.loop = e.target.checked; scheduleAutosave(); });
$('tl-fps').addEventListener('change', (e) => { state.fps = Number(e.target.value); setTime(state.time); scheduleAutosave(); });
$('tl-duration').addEventListener('change', (e) => {
  state.duration = clamp(Number(e.target.value) || 10, 1, 600);
  setTime(state.time);
  resize();
  scheduleAutosave();
});

window.addEventListener('keydown', (e) => {
  if (typing(e) || e.ctrlKey || e.metaKey) return;
  if (!$('viewer').hidden) { if (e.code === 'Escape') $('viewer').hidden = true; return; }
  const frame = 1 / state.fps;
  switch (e.code) {
    case 'Tab': e.preventDefault(); setMode(mode === 'camera' ? 'free' : 'camera'); break;
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'KeyK': setKeyNow(); break;
    case 'KeyM': addMarker(); break;
    case 'Delete': case 'Backspace': deleteSelectedKey(); break;
    case 'ArrowLeft': setTime(state.time - frame * (e.shiftKey ? 10 : 1)); break;
    case 'ArrowRight': setTime(state.time + frame * (e.shiftKey ? 10 : 1)); break;
    case 'Home': setTime(0); break;
    case 'End': setTime(state.duration); break;
    case 'KeyR': if (e.shiftKey) renderCurrentFrame(); break;
    case 'KeyW': if (mode === 'free') gizmo.setMode('translate'); break;
    case 'KeyE': if (mode === 'free') gizmo.setMode('rotate'); break;
    default: return;
  }
});

// ------------------------------------------------------------------ project files
function setStatus(text) { $('status').textContent = text; }

function serialise() {
  return {
    app: 'cinematic', version: 1,
    duration: state.duration, fps: state.fps, time: state.time, loop: state.loop, autoKey: state.autoKey,
    markers: state.markers, scene: state.scene, pose: state.pose, mount: state.mount,
    camera: { keys: track.toJSON(), rest: { pos: camLocal.position.toArray(), quat: camLocal.quaternion.toArray(), fov: shotCam.fov } },
    actor: { name: actors[1].name, pos: actorRoot.position.toArray(), quat: actorRoot.quaternion.toArray() },
  };
}

function load(data) {
  if (!data || data.app !== 'cinematic') throw new Error('Not a Cinematic project file');
  const d = defaults();
  Object.assign(state, d, {
    duration: data.duration ?? d.duration, fps: data.fps ?? d.fps, time: 0, loop: !!data.loop, autoKey: !!data.autoKey,
    markers: data.markers ?? [], scene: { ...d.scene, ...data.scene }, pose: { ...(data.pose ?? {}) }, mount: { ...d.mount, ...data.mount },
  });
  applyPose();
  track = new CameraTrack(data.camera?.keys ?? []);
  selectedKey = null;
  if (data.camera?.rest) {
    camLocal.position.fromArray(data.camera.rest.pos);
    camLocal.quaternion.fromArray(data.camera.rest.quat);
    shotCam.fov = data.camera.rest.fov;
    shotCam.updateProjectionMatrix();
  }
  syncMountUI();
  if (data.actor) { actorRoot.position.fromArray(data.actor.pos); actorRoot.quaternion.fromArray(data.actor.quat); }
  applyScene();
  setTime(data.time ?? 0);
  keysChanged();
  resize();
}

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serialise())); } catch { /* storage unavailable: nothing to do */ }
  }, 600);
}

$('btn-save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(serialise(), null, 1)], { type: 'application/json' }));
  a.download = 'shot.cinematic.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Project saved');
});
$('btn-open').addEventListener('click', () => $('file-open').click());
$('file-open').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { load(JSON.parse(await file.text())); setStatus(`Opened ${file.name}`); }
  catch (err) { setStatus(`Could not open ${file.name}: ${err.message}`); }
});
$('btn-new').addEventListener('click', () => {
  if (!window.confirm('Start a new project? Unsaved changes will be lost.')) return;
  Object.assign(state, defaults());
  applyPose();
  track = new CameraTrack();
  selectedKey = null;
  actorRoot.position.set(0, 0, 0); actorRoot.quaternion.identity();
  resetCameras();
  applyScene(); setTime(0); keysChanged(); resize();
  setStatus('New project');
});

// ------------------------------------------------------------------ model import (files stay on this computer)
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  importFiles(files);
});

async function importFiles(files) {
  const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (!main) { setStatus('No .glb or .gltf file in that folder'); return; }
  const urls = new Map(files.map((f) => [f.name.toLowerCase(), URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  let missing = 0;
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    // Textures are referenced by relative path; match them to the picked files by file name.
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]).toLowerCase();
    return urls.get(name) || url;
  });
  manager.onError = () => { missing++; };
  setStatus(`Loading ${main.name}…`);
  try {
    const gltf = await new GLTFLoader(manager).loadAsync(urls.get(main.name.toLowerCase()));
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      if (o.isSkinnedMesh) o.frustumCulled = false;
      const m = o.material;
      if (m.name.includes('shiny_lense')) {          // clear layer over the eyes
        Object.assign(m, { transparent: true, opacity: 0.1, roughness: 0.05, depthWrite: false, map: null });
        o.renderOrder = 2; o.castShadow = false;
      } else if (m.alphaTest > 0) {
        Object.assign(m, { alphaToCoverage: true, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
      }
    });
    actorRoot.clear();
    actorRoot.add(gltf.scene);
    collectBones();
    applyPose();
    syncMountUI();
    actors[1].name = main.name.replace(/\.(glb|gltf)$/i, '');
    rebuildActors();
    setStatus(missing ? `Loaded ${main.name} · ${missing} texture(s) not found in the folder` : `Loaded ${main.name}`);
  } catch (err) {
    setStatus(`Could not load ${main.name}: ${err.message}`);
  }
}

// ------------------------------------------------------------------ assistant tools
const round3 = (v) => +v.toFixed(3);
const scratchCam = new THREE.PerspectiveCamera(40, SHOT_ASPECT, 0.05, 800);

function poseCamera(cam, input) {
  cam.position.fromArray(vec3In(input.position, 'position'));
  cam.lookAt(...vec3In(input.look_at, 'look_at'));
  if (input.roll_deg !== undefined && cam === shotCam && lookAtActive()) {
    state.mount.roll = numIn(input.roll_deg, 'roll_deg', -45, 45);
  } else if (input.roll_deg !== undefined) {
    euler.setFromQuaternion(cam.quaternion, 'YXZ');
    euler.z = THREE.MathUtils.degToRad(numIn(input.roll_deg, 'roll_deg', -45, 45));
    cam.quaternion.setFromEuler(euler);
  }
  if (input.focal_mm !== undefined) cam.fov = fovFromFocal(numIn(input.focal_mm, 'focal_mm', 12, 200));
  cam.updateProjectionMatrix();
}

/** Render a small JPEG through any camera, for the assistant to look at. Returns base64. */
function captureJpeg(cam, width = 768, height = 432) {
  const aspect = cam.aspect;
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setScissorTest(false);
  cam.aspect = width / height;
  cam.updateProjectionMatrix();
  setOverlays(false);
  renderer.setViewport(0, 0, width, height);
  renderer.render(scene, cam);
  const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  setOverlays(true);
  cam.aspect = aspect;
  cam.updateProjectionMatrix();
  resize();
  draw();
  return data;
}

function sceneSummary() {
  const boneCount = Object.keys(bones).length;
  const box = new THREE.Box3().setFromObject(actorRoot);
  const toward = new THREE.Vector3(0, 0, -1).applyQuaternion(shotCam.quaternion);
  return {
    time: round3(state.time), duration: state.duration, fps: state.fps,
    camera: {
      position: shotCam.position.toArray().map(round3),
      looking_toward: toward.toArray().map(round3),
      focal_mm: Math.round(focalFromFov(shotCam.fov)),
      roll_deg: round3(THREE.MathUtils.radToDeg(euler.setFromQuaternion(shotCam.quaternion, 'YXZ').z)),
      moved_but_not_keyed: camDirty,
      mount: { bone: state.mount.bone, look_at_bone: state.mount.lookAt, keep_level: state.mount.level },
      key_positions_are: state.mount.bone ? 'relative to the mount bone' : 'world space',
      keys: track.keys.map((k) => ({ time: k.t, position: k.pos.map(round3), focal_mm: Math.round(focalFromFov(k.fov)), ease: k.ease })),
    },
    scene: { time_of_day: state.scene.tod, sun_heading: state.scene.azimuth, exposure: state.scene.exposure, fog: state.scene.fog },
    actor: {
      name: actors[1].name,
      position: actorRoot.position.toArray().map(round3),
      heading_deg: round3(THREE.MathUtils.radToDeg(actorRoot.rotation.y)),
      has_skeleton: boneCount > 0, bone_count: boneCount, posed_bones: Object.keys(state.pose).length,
      bounds: { min: box.min.toArray().map(round3), max: box.max.toArray().map(round3) },
    },
    markers: state.markers,
  };
}

const toolHandlers = {
  get_scene: () => JSON.stringify(sceneSummary()),
  set_time: (i) => { setTime(numIn(i.seconds, 'seconds')); return `Playhead at ${state.time}s`; },
  set_timeline: (i) => {
    if (i.duration !== undefined) state.duration = numIn(i.duration, 'duration', 1, 600);
    if (i.fps !== undefined) { if (![24, 30, 60, 120].includes(i.fps)) throw new Error('fps must be 24, 30, 60 or 120'); state.fps = i.fps; }
    setTime(state.time); syncKeyUI(); resize();
    return `Timeline is ${state.duration}s at ${state.fps} fps`;
  },
  set_camera: (i) => {
    poseCamera(shotCam, i);
    syncLocalFromWorld();
    if (i.key) setKeyNow(); else camDirty = track.keys.length > 0;
    return i.key ? `Camera placed and keyed at ${state.time}s` : 'Camera placed (not keyed)';
  },
  set_camera_keys: (i) => {
    if (!Array.isArray(i.keys) || !i.keys.length) throw new Error('keys must be a non-empty list');
    if (i.replace) track = new CameraTrack();
    scratchCam.fov = shotCam.fov;
    for (const k of i.keys) {
      const t = clamp(snap(numIn(k.time, 'time')), 0, state.duration);
      poseCamera(scratchCam, k);
      updateFrame();
      toLocal(mountFrame, scratchCam, scratchCam);        // store the key relative to the mount
      const key = track.setKey(t, scratchCam);
      if (k.ease !== undefined) { if (!EASE_MODES.includes(k.ease)) throw new Error(`Unknown ease "${k.ease}"`); key.ease = k.ease; }
    }
    selectedKey = null; camDirty = false;
    keysChanged();
    return `Camera now has ${track.keys.length} key(s) at ${track.keys.map((k) => `${k.t}s`).join(', ')}`;
  },
  delete_camera_keys: (i) => {
    let removed = 0;
    if (i.times === undefined) { removed = track.keys.length; track = new CameraTrack(); }
    else for (const t of i.times) { const k = track.keyAt(snap(numIn(t, 'time'))); if (k && track.removeKey(k)) removed++; }
    selectedKey = null;
    keysChanged();
    return `Removed ${removed} key(s); ${track.keys.length} left`;
  },
  set_scene: (i) => {
    const s = state.scene;
    if (i.time_of_day !== undefined) s.tod = numIn(i.time_of_day, 'time_of_day', 0, 24);
    if (i.sun_heading !== undefined) s.azimuth = ((numIn(i.sun_heading, 'sun_heading') % 360) + 360) % 360;
    if (i.exposure !== undefined) s.exposure = numIn(i.exposure, 'exposure', 0.2, 3);
    if (i.fog !== undefined) s.fog = numIn(i.fog, 'fog', 0, 0.15);
    applyScene();
    return JSON.stringify({ time_of_day: s.tod, sun_heading: s.azimuth, exposure: s.exposure, fog: s.fog });
  },
  mount_camera: (i) => {
    if (!Object.keys(bones).length) throw new Error('The actor has no skeleton. Import a rigged model to mount the camera on it.');
    if (i.preset !== undefined && i.preset !== 'none') return `${applyMountPreset(i.preset)} set: mounted on ${state.mount.bone}`;
    for (const key of ['bone', 'look_at_bone']) if (i[key] && !bones[i[key]]) throw new Error(`No bone named "${i[key]}"`);
    const next = {};
    if (i.preset === 'none') Object.assign(next, { bone: null, lookAt: null, level: false });
    if (i.bone !== undefined) next.bone = i.bone || null;
    if (i.look_at_bone !== undefined) next.lookAt = i.look_at_bone || null;
    if (i.keep_level !== undefined) next.level = !!i.keep_level;
    setMount(next);
    return JSON.stringify({ bone: state.mount.bone, look_at_bone: state.mount.lookAt, keep_level: state.mount.level });
  },
  move_actor: (i) => {
    if (i.position !== undefined) actorRoot.position.fromArray(vec3In(i.position, 'position'));
    if (i.heading_deg !== undefined) actorRoot.rotation.set(0, THREE.MathUtils.degToRad(numIn(i.heading_deg, 'heading_deg')), 0);
    return `Actor at ${actorRoot.position.toArray().map(round3).join(', ')}`;
  },
  add_markers: (i) => {
    if (!Array.isArray(i.markers)) throw new Error('markers must be a list');
    for (const m of i.markers) {
      const t = clamp(snap(numIn(m.time, 'time')), 0, state.duration);
      if (!state.markers.some((x) => Math.abs(x.t - t) < 1e-4)) state.markers.push({ t, label: String(m.label).slice(0, 40) });
    }
    state.markers.sort((a, b) => a.t - b.t);
    rebuildMarkers();
    return `${state.markers.length} marker(s) on the timeline`;
  },
  list_bones: () => {
    const names = Object.keys(bones);
    if (!names.length) throw new Error('The actor has no skeleton. Import a rigged model to pose it.');
    actorRoot.updateMatrixWorld(true);
    return JSON.stringify(names.map((n) => {
      const b = bones[n];
      return { name: n, parent: b.parent?.isBone ? b.parent.name : null, position: b.getWorldPosition(_pa).toArray().map(round3) };
    }));
  },
  pose_bones: (i) => {
    if (!Object.keys(bones).length) throw new Error('The actor has no skeleton. Import a rigged model to pose it.');
    if (!Array.isArray(i.operations) || !i.operations.length) throw new Error('operations must be a non-empty list');
    i.operations.forEach((op, n) => { try { poseBone(op); } catch (err) { throw new Error(`Operation ${n + 1} (${op?.bone}): ${err.message}. Earlier operations were applied.`); } });
    return `Applied ${i.operations.length} operation(s)`;
  },
  reset_pose: (i) => {
    if (i.bones === undefined) state.pose = {};
    else for (const n of i.bones) delete state.pose[n];
    applyPose();
    return `${Object.keys(state.pose).length} bone(s) still posed`;
  },
  capture_view: (i) => {
    let cam = shotCam, label = `Shot camera at ${state.time}s`;
    if (i.view === 'custom') {
      cam = scratchCam;
      cam.fov = 40;
      poseCamera(cam, { position: vec3In(i.from, 'from'), look_at: vec3In(i.at, 'at') });
      label = `Custom view from ${i.from.join(', ')}`;
    } else {
      applyTrack();
    }
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: captureJpeg(cam) } },
      { type: 'text', text: label },
    ];
  },
};

async function execTool(name, input) {
  const handler = toolHandlers[name];
  if (!handler) throw new Error(`Unknown tool "${name}"`);
  const result = handler(input ?? {});
  scheduleAutosave();
  return result;
}

// ------------------------------------------------------------------ assistant panel
const AI_KEY_STORE = 'cinematic.apikey.v1';
const TOOL_LABELS = {
  get_scene: 'Reading the scene', set_time: 'Moving the playhead', set_timeline: 'Changing the timeline',
  set_camera: 'Placing the camera', set_camera_keys: 'Keying the camera', delete_camera_keys: 'Deleting camera keys',
  set_scene: 'Adjusting sky and light', mount_camera: 'Mounting the camera', move_actor: 'Moving the actor', add_markers: 'Adding markers',
  list_bones: 'Reading the skeleton', pose_bones: 'Posing bones', reset_pose: 'Resetting the pose', capture_view: 'Looking at the result',
};
const aiMessages = [];
let aiAbort = null, aiUndo = null, aiClientOverride = null;

function aiKey() { try { return localStorage.getItem(AI_KEY_STORE) || ''; } catch { return ''; } }
function aiLog(kind, text) {
  const d = document.createElement('div');
  d.className = `ai-msg ${kind}`;
  d.textContent = text;
  $('ai-log').append(d);
  $('ai-log').scrollTop = $('ai-log').scrollHeight;
}
function syncAi() {
  const busy = !!aiAbort;
  $('ai-send').disabled = busy;
  $('ai-stop').disabled = !busy;
  $('ai-undo').disabled = busy || !aiUndo;
  $('ai-key-state').textContent = aiKey() ? 'A key is saved on this computer.' : 'No key saved yet.';
}

async function aiSend(text) {
  text = text.trim();
  if (!text || aiAbort) return;
  const client = aiClientOverride || (aiKey() ? createClient(aiKey()) : null);
  if (!client) { aiLog('notice', 'Add your Anthropic API key above first.'); return; }
  aiLog('user', text);
  const startLength = aiMessages.length;
  aiUndo = JSON.stringify(serialise());
  aiMessages.push({ role: 'user', content: text });
  aiAbort = new AbortController();
  syncAi();
  try {
    await runTurn({
      client, messages: aiMessages, execute: execTool, signal: aiAbort.signal,
      onEvent: (e) => aiLog(e.type === 'tool' ? 'tool' : e.type === 'text' ? 'reply' : 'notice', e.type === 'tool' ? `${TOOL_LABELS[e.name] || e.name}…` : e.text),
    });
  } catch (err) {
    aiMessages.length = startLength;          // drop the unfinished exchange so the next request starts clean
    aiLog('notice', describeError(err));
  } finally {
    aiAbort = null;
    syncAi();
    scheduleAutosave();
  }
}

$('ai-send').addEventListener('click', () => { const t = $('ai-input').value; $('ai-input').value = ''; aiSend(t); });
$('ai-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('ai-send').click(); }
});
$('ai-stop').addEventListener('click', () => aiAbort?.abort());
$('ai-undo').addEventListener('click', () => {
  if (!aiUndo) return;
  load(JSON.parse(aiUndo));
  aiUndo = null;
  aiLog('notice', "Undid the assistant's last set of changes.");
  syncAi();
});
$('ai-key-save').addEventListener('click', () => {
  const v = $('ai-key').value.trim();
  try { if (v) localStorage.setItem(AI_KEY_STORE, v); else localStorage.removeItem(AI_KEY_STORE); }
  catch { aiLog('notice', 'This browser would not store the key.'); }
  $('ai-key').value = '';
  syncAi();
});
$('ai-model').textContent = MODEL;
syncAi();

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) {
    let t = state.time + dt;
    if (t >= state.duration) { if (state.loop) t = 0; else { t = state.duration; playing = false; syncPlayButton(); } }
    state.time = t;                       // not snapped while playing, so motion stays smooth
    camDirty = false;
    updatePlayhead();
  }
  fly.update(dt, false);
  applyTrack();
  if (mode === 'free') orbit.update();
  syncInspector();
  draw();
  requestAnimationFrame(tick);
}

new ResizeObserver(resize).observe(viewEl);
new ResizeObserver(resize).observe(tracksEl);
try {
  const saved = localStorage.getItem(AUTOSAVE_KEY);
  if (saved) { load(JSON.parse(saved)); setStatus('Restored your last session'); }
} catch { /* no autosave or it was unreadable: start fresh */ }
applyScene();
rebuildActors();
syncMountUI();
setMode('free');
keysChanged();
resize();
syncPlayButton();
tick();

// Handle for automated checks and for poking at things from the console.
window.app = {
  state, get track() { return track; }, get bones() { return bones; }, shotCam, freeCam, actorRoot,
  setTime, setMode, setKeyNow, setMount, applyMountPreset, selectActor, renderStill, serialise, load, importFiles, execTool,
  assistant: { send: aiSend, messages: aiMessages, useClient(c) { aiClientOverride = c; } },
};
