import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CameraTrack, EASE_MODES } from './keys.js';
import { FlyLook } from './flylook.js';

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
scene.add(shotCam, camHelper, pathLine, keyDots);

function resetCameras() {
  shotCam.position.set(2.6, 1.5, 3.4);
  shotCam.lookAt(0, 1.1, 0);
  shotCam.fov = fovFromFocal(35);
  shotCam.updateProjectionMatrix();
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
  const night = e <= 0;
  const el = Math.asin(clamp(Math.abs(e), 0.08, 1));
  const az = THREE.MathUtils.degToRad(s.azimuth + (night ? 180 : 0));
  sun.position.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(25);
  if (night) { sun.color.copy(MOON); sun.intensity = 1.1; }
  else { sun.color.copy(SUN_LOW).lerp(SUN_HIGH, clamp(e * 1.6, 0, 1)); sun.intensity = 3.2 * Math.pow(e, 0.6); }
  hemi.intensity = 0.3 + 0.6 * Math.max(0, e);
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

function applyTrack() {
  if (camDirty || !track.evaluate(state.time, pose)) return;
  shotCam.position.copy(pose.position);
  shotCam.quaternion.copy(pose.quaternion);
  if (shotCam.fov !== pose.fov) { shotCam.fov = pose.fov; shotCam.updateProjectionMatrix(); }
}

function setKeyNow() {
  selectedKey = track.setKey(state.time, shotCam);
  camDirty = false;
  keysChanged();
}

function deleteSelectedKey() {
  if (!selectedKey || !track.removeKey(selectedKey)) return;
  selectedKey = null;
  keysChanged();
}

/** The shot camera was moved by the user (fly, lens, gizmo). */
function cameraEdited() {
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
  bindRange('cam-roll', () => THREE.MathUtils.radToDeg(euler.setFromQuaternion(shotCam.quaternion, 'YXZ').z),
    (v) => { euler.setFromQuaternion(shotCam.quaternion, 'YXZ'); euler.z = THREE.MathUtils.degToRad(v); shotCam.quaternion.setFromEuler(euler); cameraEdited(); },
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
    markers: state.markers, scene: state.scene,
    camera: { keys: track.toJSON(), rest: { pos: shotCam.position.toArray(), quat: shotCam.quaternion.toArray(), fov: shotCam.fov } },
    actor: { name: actors[1].name, pos: actorRoot.position.toArray(), quat: actorRoot.quaternion.toArray() },
  };
}

function load(data) {
  if (!data || data.app !== 'cinematic') throw new Error('Not a Cinematic project file');
  const d = defaults();
  Object.assign(state, d, {
    duration: data.duration ?? d.duration, fps: data.fps ?? d.fps, time: 0, loop: !!data.loop, autoKey: !!data.autoKey,
    markers: data.markers ?? [], scene: { ...d.scene, ...data.scene },
  });
  track = new CameraTrack(data.camera?.keys ?? []);
  selectedKey = null;
  if (data.camera?.rest) {
    shotCam.position.fromArray(data.camera.rest.pos);
    shotCam.quaternion.fromArray(data.camera.rest.quat);
    shotCam.fov = data.camera.rest.fov;
    shotCam.updateProjectionMatrix();
  }
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
  track = new CameraTrack();
  selectedKey = null;
  actorRoot.position.set(0, 0, 0); actorRoot.quaternion.identity();
  resetCameras();
  applyScene(); setTime(0); keysChanged(); resize();
  setStatus('New project');
});

// ------------------------------------------------------------------ model import (files stay on this computer)
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (!main) { setStatus('No .glb or .gltf file in that folder'); return; }
  const urls = new Map(files.map((f) => [f.name.toLowerCase(), URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  let missing = 0;
  manager.setURLModifier((url) => {
    if (/^(blob|data):/.test(url) && !url.includes('/textures/')) return url;
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
    actors[1].name = main.name.replace(/\.(glb|gltf)$/i, '');
    rebuildActors();
    setStatus(missing ? `Loaded ${main.name} · ${missing} texture(s) not found in the folder` : `Loaded ${main.name}`);
  } catch (err) {
    setStatus(`Could not load ${main.name}: ${err.message}`);
  }
});

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
setMode('free');
keysChanged();
resize();
syncPlayButton();
tick();

// Handle for automated checks and for poking at things from the console.
window.app = { state, get track() { return track; }, shotCam, freeCam, actorRoot, setTime, setMode, setKeyNow, selectActor, renderStill, serialise, load };
