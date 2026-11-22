import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CameraTrack, EASE_MODES } from './keys.js';
import { FlyLook } from './flylook.js';
import { toLocal, toWorld, reframeKeys, bodyAxes } from './mount.js';
import { Clip } from './anim.js';
import { decodeDDS, gameNormalToStandard, gameSpecToRoughness, applyCamo } from './dds.js';
import { twoBoneReach } from './ik.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { createWeather, WEATHER } from './weather.js';
import { createLook, lookIsActive, LOOKS, LOOK_OFF } from './look.js';
import { frameTimes, subframeTimes, safeName, canMakeMp4, createMp4Sink, createPngSink, lensOffsets, addSample, resolveSamples, focusAt } from './renderqueue.js';
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
  mount: { bone: null, lookAt: null, level: false, roll: 0, lag: 0 },   // what the shot camera rides on
  props: [],                                  // settings for attached props, by name: { name, bone, hidden }
  anim: { name: null, start: 0, speed: 1, loop: true, travel: true, ground: true },   // which imported animation plays on the actor
  next: { name: null, at: 2, blend: 0.25, speed: 1, loop: false },
  chain: [],                                  // more animations after that one, each { name, at, blend, speed, loop }      // an animation that takes over from it part-way through
  dof: { blur: 0, bone: '', distance: 3, keys: [] },   // depth of field: how much blur, and what stays sharp (a bone, or a keyed distance)
  poseKeys: [],                               // poses keyed over time: [{ t, pose: { bone: offset } }]
  pose: {},                                   // bone name -> rotation offset layered on top of the animation (or the imported pose)
  scene: { tod: 15, azimuth: 60, exposure: 1, fog: 0, grid: true, weather: 'clear' },
  look: { ...LOOK_OFF, tint: [...LOOK_OFF.tint] },   // the finish applied after the scene is drawn: glow, grade, grain, rim light
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x30302c, 0.8);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 60 });
sun.shadow.radius = 3;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.02;
const rim = new THREE.DirectionalLight(0xbcd2ff, 0);   // back light that separates him from the background; part of the look
const fill = new THREE.DirectionalLight(0xffffff, 0);  // soft light from the camera's side so a back-lit subject is not a silhouette; part of the look
scene.add(hemi, sun, sun.target, rim, rim.target, fill, fill.target);

// A sky that is lighter at the horizon and glows around the sun, instead of one flat colour.
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uGlow: { value: new THREE.Color() } },
  vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 uZenith, uHorizon, uSun, uGlow; varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      vec3 c = mix(uHorizon, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.55));
      float s = max(dot(d, uSun), 0.0);
      c += uGlow * (pow(s, 12.0) * 0.35 + pow(s, 400.0) * 6.0);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
skyDome.renderOrder = -10;
skyDome.frustumCulled = false;
skyDome.onBeforeRender = (r, s, camera) => { skyDome.position.setFromMatrixPosition(camera.matrixWorld); skyDome.updateMatrixWorld(); };
scene.add(skyDome);
const sunOffset = new THREE.Vector3(0, 25, 0), rimOffset = new THREE.Vector3(0, 10, -20), lightFocus = new THREE.Vector3();
/** Keep the sun, its shadow and the rim light centred on the character wherever the animation has carried him. */
function followLights() {
  const centre = bones.j_mainroot || bones.tag_origin;
  if (centre) { actorRoot.updateMatrixWorld(true); centre.getWorldPosition(lightFocus); } else lightFocus.copy(actorRoot.position);
  lightFocus.y = 1;
  sun.target.position.copy(lightFocus); sun.position.copy(lightFocus).addScaledVector(sunOffset, mapName ? 3 : 1);
  rim.target.position.copy(lightFocus); rim.position.copy(lightFocus).add(rimOffset);
  fill.target.position.copy(lightFocus); fill.position.copy(shotCam.position); fill.position.y += 0.6;
}

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
  if (gizmo.object === shotCam) cameraEdited();
  else if (gizmo.object?.isBone) {                    // posing a bone by hand: keep the turn as an offset over the animation
    const bone = gizmo.object, base = baseQuat.get(bone.name) || lastBase.get(bone.name) || bone.quaternion.clone();
    state.pose[bone.name] = _dq.copy(base).invert().multiply(bone.quaternion).toArray();
    poseEdited();
    syncPoseUI();
  } else scheduleAutosave();
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
    if (o.isBone && !bones[o.name]) {
      bones[o.name] = o;
      const slot = () => ({ q: new THREE.Quaternion(), p: new THREE.Vector3() });
      bindPose.set(o.name, { q: o.quaternion.toArray(), p: o.position.toArray(), a: slot(), b: slot() });
    }
  });
  if (legacyPose) {                                  // poses saved by older versions were absolute rotations
    for (const [name, q] of Object.entries(legacyPose)) {
      if (!bindPose.has(name)) continue;
      state.pose[name] = _dq.fromArray(bindPose.get(name).q).invert().multiply(_bq.fromArray(q)).toArray();
    }
    legacyPose = null;
  }
}

const clipLibrary = new Map();                       // imported animations by name; never saved with the project
const baseQuat = new Map();                          // rotation of each posed bone before its offset is applied
const _dq = new THREE.Quaternion(), _bq = new THREE.Quaternion();
let legacyPose = null;

const activeClip = () => (state.anim.name ? clipLibrary.get(state.anim.name) || null : null);

const nextClip = () => (activeClip() && state.next.name ? clipLibrary.get(state.next.name) || null : null);
const _ra = new THREE.Vector3(), _rqa = new THREE.Quaternion(), _rb = new THREE.Vector3(), _rqb = new THREE.Quaternion();

/** Work out every bone's pose from one clip at a moment, into scratch slot 'a' or 'b'. */
function poseFromClip(clip, seconds, loop, slot) {
  for (const bind of bindPose.values()) { bind[slot].q.fromArray(bind.q); bind[slot].p.fromArray(bind.p); }
  const frame = clip.frameAt(seconds, loop);
  for (const track of clip.bones) {
    const bind = bindPose.get(track.name);
    if (!bind) continue;
    if (!Clip.rotation(track, frame, bind[slot].q)) bind[slot].q.identity();
    if (Clip.position(track, frame, _pa)) bind[slot].p.add(_pa);     // positions are shifts added to the model's own bone offset
  }
}

/** Rebuild the actor for the current time: imported pose, then the animation(s), then pose offsets on top. */
/** The animations in the order they play: the first, the one that takes over from it, then any others. */
function clipSequence() {
  const first = activeClip();
  if (!first) return [];
  const seq = [{ clip: first, at: state.anim.start, blend: 0, speed: state.anim.speed, loop: state.anim.loop }];
  const later = [state.next, ...state.chain].filter((c) => c.name && clipLibrary.has(c.name)).sort((x, y) => x.at - y.at);
  for (const c of later) seq.push({ clip: clipLibrary.get(c.name), at: c.at, blend: c.blend || 0, speed: c.speed || 1, loop: !!c.loop });
  return seq;
}

function applyActor() {
  const seq = clipSequence(), first = seq[0]?.clip;
  let at = 0;
  while (at + 1 < seq.length && seq[at + 1].at <= state.time) at++;
  const cur = seq[at], prev = at > 0 ? seq[at - 1] : null;             // the one playing now, and the one it took over from
  const mix = prev ? (cur.blend > 1e-4 ? clamp((state.time - cur.at) / cur.blend, 0, 1) : 1) : 0;
  const from = prev || cur;
  if (from && mix < 1) poseFromClip(from.clip, (state.time - from.at) * from.speed, from.loop, 'a');
  if (prev && mix > 0) poseFromClip(cur.clip, (state.time - cur.at) * cur.speed, cur.loop, 'b');
  for (const [name, bind] of bindPose) {
    const bone = bones[name];
    if (!first) { bone.quaternion.fromArray(bind.q); bone.position.fromArray(bind.p); }
    else if (mix <= 0) { bone.quaternion.copy(bind.a.q); bone.position.copy(bind.a.p); }
    else if (mix >= 1) { bone.quaternion.copy(bind.b.q); bone.position.copy(bind.b.p); }
    else { bone.quaternion.slerpQuaternions(bind.a.q, bind.b.q, mix); bone.position.lerpVectors(bind.a.p, bind.b.p, mix); }
  }
  const origin = bones.tag_origin;
  if (first && state.anim.travel && origin) {                         // carry the whole character the way the animations move
    _ra.set(0, 0, 0); _rqa.identity();
    for (let k = 0; k <= at; k++) {                                   // each one continues from where the one before left him
      const s = seq[k], until = k < at ? seq[k + 1].at : state.time;
      s.clip.rootAt(Math.max(0, until - s.at) * s.speed, s.loop, _rb, _rqb);
      _ra.add(_rb.applyQuaternion(_rqa));
      _rqa.multiply(_rqb);
    }
    origin.position.add(_ra);
    origin.quaternion.multiply(_rqa);
  }
  if (first && state.anim.ground !== false) keepAboveGround();
  if (state.poseKeys.length && !poseDirty) state.pose = poseAt(state.time);
  if (poseBoneName && bones[poseBoneName]) lastBase.set(poseBoneName, bones[poseBoneName].quaternion.clone());
  baseQuat.clear();
  for (const [name, d] of Object.entries(state.pose)) {
    const bone = bones[name];
    if (!bone) continue;
    baseQuat.set(name, bone.quaternion.clone());
    bone.quaternion.multiply(_dq.fromArray(d));
  }
}
const applyPose = applyActor;

// ---- ground contact: animations are made for the game's uneven floors, so a hand or foot can sink into flat ground
const LIMBS = [['j_shoulder_le', 'j_elbow_le', 'j_wrist_le'], ['j_shoulder_ri', 'j_elbow_ri', 'j_wrist_ri'], ['j_hip_le', 'j_knee_le', 'j_ankle_le'], ['j_hip_ri', 'j_knee_ri', 'j_ankle_ri']];
const GROUND_CLEAR = 0.015;                          // metres a joint is kept above the ground (roughly a finger's thickness)
const _ia = new THREE.Vector3(), _ib = new THREE.Vector3(), _ic = new THREE.Vector3(), _iq = new THREE.Quaternion(), _iv = new THREE.Vector3();
function keepAboveGround() {
  actorRoot.updateMatrixWorld(true);
  for (const [upperName, midName, endName] of LIMBS) {
    const upper = bones[upperName], mid = bones[midName], end = bones[endName];
    if (!upper || !mid || !end) continue;
    let low = Infinity;                              // lowest joint of the hand or foot, fingers and toes included
    end.traverse((o) => { if (bones[o.name] === o && !o.name.startsWith('tag_')) low = Math.min(low, o.matrixWorld.elements[13]); });
    const lift = actorRoot.position.y + GROUND_CLEAR - low;      // the ground is wherever he has been stood
    if (!(lift > 0)) continue;
    const a = upper.getWorldPosition(_ia).toArray(), b = mid.getWorldPosition(_ib).toArray(), c = end.getWorldPosition(_ic).toArray();
    const r = twoBoneReach(a, b, c, [c[0], c[1] + lift, c[2]]);
    worldRotate(upper, _iq.setFromAxisAngle(_iv.fromArray(r.bendAxis), r.upperBend));
    worldRotate(mid, _iq.setFromAxisAngle(_iv.fromArray(r.bendAxis), r.midBend));
    worldRotate(upper, _iq.setFromAxisAngle(_iv.fromArray(r.swingAxis), r.swing));
  }
}

let poseDirty = false;                               // the pose was changed by hand and not keyed yet
let poseBoneName = null;                             // bone being posed with the handle in the viewport
const lastBase = new Map();                          // what the animation alone gives that bone, as of the last rebuild
const IDENTITY = [0, 0, 0, 1];

/** The pose at a time, blended between the keyed poses on either side (eased, so it settles into each key). */
function poseAt(time) {
  const keys = state.poseKeys;
  if (time <= keys[0].t) return { ...keys[0].pose };
  const last = keys[keys.length - 1];
  if (time >= last.t) return { ...last.pose };
  let i = 0;
  while (keys[i + 1].t <= time) i++;
  const a = keys[i], b = keys[i + 1];
  let u = (time - a.t) / (b.t - a.t);
  u = u * u * (3 - 2 * u);
  const out = {};
  for (const name of new Set([...Object.keys(a.pose), ...Object.keys(b.pose)])) {
    out[name] = _dq.fromArray(a.pose[name] || IDENTITY).slerp(_bq.fromArray(b.pose[name] || IDENTITY), u).toArray();
  }
  return out;
}

function poseEdited() {
  if (state.autoKey) keyPose();
  else { poseDirty = state.poseKeys.length > 0; scheduleAutosave(); }
}

/** Store the current pose as a key at a time (the playhead by default). */
function keyPose(time = state.time) {
  const t = clamp(snap(time), 0, state.duration);
  const pose = Object.fromEntries(Object.entries(state.pose).map(([k, v]) => [k, [...v]]));
  const existing = state.poseKeys.find((k) => Math.abs(k.t - t) < 1e-4);
  if (existing) existing.pose = pose; else { state.poseKeys.push({ t, pose }); state.poseKeys.sort((x, y) => x.t - y.t); }
  poseDirty = false;
  rebuildPoseKeys();
  syncPoseUI();
  scheduleAutosave();
}

function deletePoseKey(key) {
  const i = state.poseKeys.indexOf(key);
  if (i < 0) return;
  state.poseKeys.splice(i, 1);
  rebuildPoseKeys();
  syncPoseUI();
  scheduleAutosave();
}

function clearPose(names) {
  if (!names) state.pose = {}; else for (const n of names) delete state.pose[n];
  poseEdited();
  syncPoseUI();
}

function setPoseBone(name) {
  poseBoneName = name && bones[name] ? name : null;
  if (poseBoneName) { selectedActor = null; rebuildActors(); applyActor(); }
  attachGizmo();
  syncPoseUI();
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
  const base = baseQuat.get(bone.name) || bone.quaternion.clone();     // what the animation alone gives this bone
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
  baseQuat.set(bone.name, base);
  state.pose[bone.name] = _dq.copy(base).invert().multiply(bone.quaternion).toArray();   // store the offset, not the result
  poseDirty = state.poseKeys.length > 0;
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
const WHITE = new THREE.Color(0xffffff);
const NIGHT = new THREE.Color(0x0a0f1c), HORIZON = new THREE.Color(0xd98f5c), DAY = new THREE.Color(0x7fa9d6);
const SUN_LOW = new THREE.Color(0xffa860), SUN_HIGH = new THREE.Color(0xfff4e6), MOON = new THREE.Color(0x9bb8ff);
const sky = new THREE.Color();
scene.background = sky;
const weather = createWeather(() => state.time);
scene.add(weather.group);
const look = createLook(renderer, scene);
/** Draw the scene through a camera, with the look unless `plain`. */
function renderShot(cam, plain = false) {
  if (!plain && lookIsActive(state.look)) look.render(cam, state.look, state.time); else renderer.render(scene, cam);
}
let skyImage = null;                                 // an imported panorama used as the sky and as the light from it (not saved with the project)

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
  sunOffset.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(25);
  rimOffset.set(-Math.sin(az), 0.55, -Math.cos(az)).multiplyScalar(20);      // from behind, opposite the sun
  rim.intensity = state.look.rim || 0;
  fill.intensity = state.look.fill || 0;
  const dome = skyDome.material.uniforms;
  dome.uHorizon.value.copy(sky).lerp(WHITE, night ? 0.05 : 0.4);
  dome.uZenith.value.copy(sky).multiplyScalar(night ? 0.5 : 0.62);
  dome.uSun.value.copy(sunOffset).normalize();
  skyDome.visible = !skyImage;
  ground.material.color.set(state.look.wet ? 0x1b1d21 : 0x8d9094);           // wet ground is dark and catches the light
  ground.material.roughness = state.look.wet ? 0.28 : 1;
  ground.visible = !mapName;                           // a loaded map brings its own ground
  followLights();
  if (night) { sun.color.copy(MOON); sun.intensity = 1.1; }
  else { sun.color.copy(SUN_LOW).lerp(SUN_HIGH, clamp(e * 1.6, 0, 1)); sun.intensity = 3.2 * Math.pow(Math.max(e, 0), 0.6) + 0.9 * twilight; }
  hemi.intensity = 0.3 + 0.6 * Math.max(0, e) + 0.35 * twilight;
  dome.uGlow.value.copy(sun.color).multiplyScalar(night ? 0.25 : 1);
  renderer.toneMappingExposure = s.exposure;
  scene.background = skyImage || sky;
  scene.environment = skyImage;
  weather.set(s.weather || 'clear');
  weather.group.visible = true;
  scene.fog = s.fog > 0 ? new THREE.FogExp2(sky.getHex(), s.fog) : null;
  grid.visible = s.grid;
}

// ------------------------------------------------------------------ time and camera track
const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 0 };
const snap = (t) => Math.round(t * state.fps) / state.fps;

function setTime(t) {
  state.time = clamp(snap(t), 0, state.duration);
  camDirty = false;
  poseDirty = false;
  updatePlayhead();
}

const lookAtActive = () => !!(state.mount.lookAt && bones[state.mount.lookAt]);

/** Work out where the mount is right now. With nothing mounted the frame is the world itself. */
function boneFrame(bone, out) {
  actorRoot.updateMatrixWorld(true);
  bone.getWorldPosition(out.position);
  if (state.mount.level) out.quaternion.identity();             // ride the position only, keep the horizon level
  else bone.getWorldQuaternion(out.quaternion);
}
const lagFrame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
const LAG_STEPS = 8;
const _lq = new THREE.Quaternion();

function updateFrame() {
  const bone = state.mount.bone && bones[state.mount.bone];
  if (!bone) { mountFrame.position.set(0, 0, 0); mountFrame.quaternion.identity(); return; }
  const lag = state.mount.lag || 0;
  if (!(lag > 0)) { boneFrame(bone, mountFrame); return; }
  // Smoothing: the mount is where the bone has recently been, weighted towards now. Worked out from the animation
  // itself rather than from the previous frame, so scrubbing and rendering at any frame rate give the same result.
  const now = state.time;
  let total = 0;
  for (let k = LAG_STEPS - 1; k >= 0; k--) {
    const age = (3 * lag * k) / (LAG_STEPS - 1), w = Math.exp(-age / lag);
    state.time = Math.max(0, now - age);
    if (k) applyActor();
    else { state.time = now; applyActor(); }
    boneFrame(bone, lagFrame);
    const root = bones.tag_origin || actorRoot;     // measured against the travelling body, so the camera smooths the shake without falling behind the run
    root.getWorldQuaternion(_lq).invert();
    root.worldToLocal(lagFrame.position);
    if (!state.mount.level) lagFrame.quaternion.premultiply(_lq);
    total += w;
    if (total === w) { mountFrame.position.copy(lagFrame.position); mountFrame.quaternion.copy(lagFrame.quaternion); }
    else { mountFrame.position.lerp(lagFrame.position, w / total); mountFrame.quaternion.slerp(lagFrame.quaternion, w / total); }
    if (!k) {                                       // the last step is the present: back out to world space from here
      root.localToWorld(mountFrame.position);
      if (!state.mount.level) mountFrame.quaternion.premultiply(_lq.invert());
    }
  }
}

/** The camera was placed in world space; remember that placement relative to the mount. */
function syncLocalFromWorld() {
  updateFrame();
  toLocal(mountFrame, shotCam, camLocal);
}

function applyTrack() {
  applyActor();
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
  followLights();
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
  rail: { label: 'Side rail cam', bones: ['tag_weapon_right', 'j_gun', 'j_wrist_ri'], lookAt: null, level: false, focal: 14, offset: [0.55, 0.10, 0.05] },
  barrel: { label: 'Barrel POV', bones: ['tag_weapon_right', 'j_gun', 'j_wrist_ri'], lookAt: null, level: false, focal: 16, offset: [0.55, 0.10, 0.05] },
  boot: { label: 'Boot cam', bones: ['j_ankle_ri', 'j_ball_ri'], lookAt: 'j_head', level: true, focal: 14, offset: [0.45, 0.04, 0.2] },
};

/** Mount the camera with a ready-made placement. offset is [forward, up, right] in metres from the mount. */
/**
 * Where an attached weapon's barrel is, measured from the visible parts of the model: the muzzle end, the direction
 * the barrel points, and "up" on the gun. Null if the prop has nothing visible.
 */
function gunShape(prop) {
  const bone = bones[prop.bone];
  actorRoot.updateMatrixWorld(true);
  propWorld.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(bone.matrixWorld).invert(), box = new THREE.Box3(), v = new THREE.Vector3(), pts = [];
  for (const root of [prop.carrier, prop.skinned]) root.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry?.attributes.position) return;
    const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += step) { o.getVertexPosition(i, v); box.expandByPoint(v.applyMatrix4(o.matrixWorld).applyMatrix4(inv)); pts.push(v.toArray()); }
  });
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3()).toArray(), lo = box.min.toArray(), hi = box.max.toArray();
  const axis = size.indexOf(Math.max(...size));
  // The muzzle is the thin end and the stock the bulky one: compare how wide the model is near each end.
  const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3, band = size[axis] * 0.12;
  const girth = (near) => {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const q of pts) if (near(q[axis])) { a0 = Math.min(a0, q[o1]); a1 = Math.max(a1, q[o1]); b0 = Math.min(b0, q[o2]); b1 = Math.max(b1, q[o2]); }
    return a1 >= a0 ? (a1 - a0) + (b1 - b0) : Infinity;
  };
  const sign = girth((x) => x > hi[axis] - band) <= girth((x) => x < lo[axis] + band) ? 1 : -1;
  const tip = box.getCenter(new THREE.Vector3()).toArray(), back = [...tip];
  const atTip = sign > 0 ? (x) => x > hi[axis] - band : (x) => x < lo[axis] + band, n = pts.filter((q) => atTip(q[axis]));
  for (const o of [o1, o2]) tip[o] = back[o] = n.reduce((m, q) => m + q[o], 0) / n.length;      // the barrel's own line, not the middle of scope, grip and bipod
  tip[axis] = sign > 0 ? hi[axis] : lo[axis];
  back[axis] = sign > 0 ? lo[axis] : hi[axis];
  const muzzle = bone.localToWorld(new THREE.Vector3().fromArray(tip)), butt = bone.localToWorld(new THREE.Vector3().fromArray(back));
  const dir = muzzle.clone().sub(butt), length = dir.length();
  dir.normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
  return { muzzle, dir, up, length };
}

function applyMountPreset(id) {
  const preset = MOUNT_PRESETS[id];
  if (!preset) throw new Error(`Unknown mount preset "${id}"`);
  if (id === 'gun' || id === 'barrel' || id === 'rail') {                                   // sit on the weapon itself when one is attached
    const prop = props.find((p) => p.bone && bones[p.bone]);
    const gun = prop && gunShape(prop);
    if (gun) {
      const face = bones.j_head;
      setMount({ bone: prop.bone, lookAt: null, level: false, roll: 0 });  // fixed to the gun: it tilts and shakes with it
      if (id === 'gun') {                                                  // on the muzzle, looking back down the barrel at him
        shotCam.position.copy(gun.muzzle).addScaledVector(gun.dir, 0.1).addScaledVector(gun.up, 0.1);
        shotCam.up.copy(gun.up);
        shotCam.lookAt(face ? face.getWorldPosition(new THREE.Vector3()) : gun.muzzle.clone().addScaledVector(gun.dir, -1).addScaledVector(gun.up, 0.07));
      } else if (id === 'rail') {                                          // clamped to the side of the barrel, looking back up at him past the gun
        const side = new THREE.Vector3().crossVectors(gun.dir, gun.up).normalize();
        shotCam.position.copy(gun.muzzle).addScaledVector(gun.dir, -0.12).addScaledVector(side, 0.11).addScaledVector(gun.up, -0.03);
        shotCam.up.copy(gun.up);
        shotCam.lookAt(face ? face.getWorldPosition(new THREE.Vector3()) : gun.muzzle.clone().addScaledVector(gun.dir, -1));
        shotCam.rotateZ(THREE.MathUtils.degToRad(-14));                    // a slight tilt, as if strapped on
        Object.assign(state.dof, { blur: Math.max(state.dof.blur, 1.5), bone: face ? 'j_head' : state.dof.bone });   // he is sharp, the gun in front is soft
      } else {                                                             // behind the muzzle, looking where the barrel points
        shotCam.position.copy(gun.muzzle).addScaledVector(gun.dir, -Math.min(0.7, gun.length * 0.5)).addScaledVector(gun.up, 0.12);
        shotCam.up.copy(gun.up);
        shotCam.lookAt(gun.muzzle.clone().addScaledVector(gun.dir, 4));
      }
      shotCam.up.set(0, 1, 0);
      shotCam.fov = fovFromFocal(id === 'barrel' ? 18 : 14);
      syncFocusUI();
      cameraEdited();
      return `${preset.label} (fixed to ${prop.name})`;
    }
    if (id !== 'gun') throw new Error(`${preset.label} needs the weapon: use Import prop to attach it to the character first.`);
  }
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
  const bone = mode === 'free' && poseBoneName ? bones[poseBoneName] : null;
  const target = bone || (mode === 'free' && selectedActor ? selectedActor.object : null);
  if (target) gizmo.attach(target); else gizmo.detach();
  if (bone) { gizmo.setMode('rotate'); gizmo.setSpace('local'); } else gizmo.setSpace('world');
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
  if (selectedActor) poseBoneName = null;
  if (selectedActor?.kind === 'light') showTab('scene');
  if (selectedActor?.kind === 'camera') showTab('camera');
  rebuildActors();
  attachGizmo();
}

// ------------------------------------------------------------------ rendering
function viewSize() { return { w: Math.max(1, viewEl.clientWidth), h: Math.max(1, viewEl.clientHeight) }; }

function resize() {
  if (rendering) return;
  const { w, h } = viewSize();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  freeCam.aspect = w / h;
  freeCam.updateProjectionMatrix();
  drawRuler();
  rebuildKeys();
  rebuildMarkers();
  rebuildAnimBar();
  rebuildPoseKeys();
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
  renderShot(shotCam, !withGrid);                    // the small preview in Free mode stays plain
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
// ---- depth of field: each sample looks from a different point on the lens, all agreeing on the focus distance
const LENS_UNIT = 0.002;                             // metres of lens radius per step of the blur slider
const DOF_SAMPLES = 24;
const _fa = new THREE.Vector3(), _fb = new THREE.Vector3();
const lensCache = new Map();

/** How far in front of the camera things are sharp right now. */
function focusDistance() {
  const d = state.dof, bone = d.bone && bones[d.bone];
  if (bone) {
    actorRoot.updateMatrixWorld(true);
    return Math.max(0.05, bone.getWorldPosition(_fa).sub(shotCam.position).dot(_fb.set(0, 0, -1).applyQuaternion(shotCam.quaternion)));
  }
  return d.keys.length ? focusAt(d.keys, state.time) : d.distance;
}

/** Shift the shot camera to lens point `k` of `n` and skew its view so the focus distance stays put. */
function applyLens(k, n) {
  shotCam.updateProjectionMatrix();
  if (!(state.dof.blur > 0) || n < 2) return;
  if (!lensCache.has(n)) lensCache.set(n, lensOffsets(n));
  const F = focusDistance(), r = state.dof.blur * LENS_UNIT, [u, v] = lensCache.get(n)[k];
  shotCam.position.add(_fa.set(u * r, v * r, 0).applyQuaternion(shotCam.quaternion));
  const P = shotCam.projectionMatrix.elements;
  P[8] = (-P[0] * u * r) / F;
  P[9] = (-P[5] * v * r) / F;
  shotCam.projectionMatrixInverse.copy(shotCam.projectionMatrix).invert();
}

const makeAccumulator = (width, height) => ({ width, height, sum: new Uint16Array(width * height * 4), px: new Uint8Array(width * height * 4) });

/** Render `total` samples and add them up. `times` gives each sample its own moment (motion blur); without it the scene is left as it is. */
function renderSamples(acc, total, times) {
  const gl = renderer.getContext();
  acc.sum.fill(0);
  for (let k = 0; k < total; k++) {
    if (times) { state.time = times[k]; camDirty = false; poseDirty = false; }
    applyTrack();
    applyLens(k, total);
    renderShot(shotCam, acc.plain);
    gl.readPixels(0, 0, acc.width, acc.height, gl.RGBA, gl.UNSIGNED_BYTE, acc.px);
    addSample(acc.sum, acc.px);
  }
  shotCam.updateProjectionMatrix();
}

/** Put the average of an accumulator's samples on a 2D canvas. */
function resolveTo(ctx, acc, total, keepAlpha) {
  const image = ctx.createImageData(acc.width, acc.height);
  resolveSamples(acc.sum, total, acc.width, acc.height, image.data, keepAlpha);
  ctx.putImageData(image, 0, 0);
}

function keyFocus(distance = focusDistance()) {
  const d = state.dof, t = clamp(snap(state.time), 0, state.duration);
  const existing = d.keys.find((k) => Math.abs(k.t - t) < 1e-4);
  if (existing) existing.distance = distance; else { d.keys.push({ t, distance }); d.keys.sort((x, y) => x.t - y.t); }
  d.distance = distance;
  d.bone = '';                                       // keyed distances drive the focus from here on
  syncFocusUI();
  scheduleAutosave();
}

function syncFocusUI() {
  const names = Object.keys(bones).sort(), sel = $('dof-bone');
  if (sel.options.length !== names.length + 1) sel.replaceChildren(new Option('A set distance', ''), ...names.map((n) => new Option(n, n)));
  if (state.dof.bone && !bones[state.dof.bone]) state.dof.bone = '';
  sel.value = state.dof.bone;
  const d = state.dof;
  $('dof-info').textContent = (d.blur > 0 ? `Sharp at ${focusDistance().toFixed(2)} m` : 'Off: everything is sharp')
    + (d.keys.length ? ` · ${d.keys.length} focus key(s) at ${d.keys.map((k) => `${k.t}s`).join(', ')}` : '')
    + '. Shows in test renders and the render queue, not in the live view.';
}

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
  let source = canvas;
  if (state.dof.blur > 0) {                            // depth of field: average many views through the lens
    const acc = makeAccumulator(width, height);
    renderSamples(acc, DOF_SAMPLES * 2, null);
    source = document.createElement('canvas');
    source.width = width; source.height = height;
    resolveTo(source.getContext('2d'), acc, DOF_SAMPLES * 2, false);
    applyTrack();
  } else renderShot(shotCam);
  const blob = await new Promise((res) => source.toBlob(res, 'image/png'));
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
  () => { if (state.dof.blur > 0 && (state.dof.keys.length || state.dof.bone)) syncFocusUI(); },   // the sharp distance changes with time
  ...[['look-bloom', 'bloom', 2], ['look-ao', 'ao', 2], ['look-sat', 'saturation', 2], ['look-contrast', 'contrast', 2], ['look-vignette', 'vignette', 2], ['look-grain', 'grain', 2], ['look-rim', 'rim', 1], ['look-fill', 'fill', 1]]
    .map(([id, key, digits]) => bindRange(id, () => state.look[key], (v) => setLook({ [key]: v }), (v) => v.toFixed(digits))),
  bindRange('cam-lag', () => state.mount.lag || 0, (v) => setMount({ lag: v }), (v) => (v === 0 ? 'off' : `${v.toFixed(2)} s`)),
  bindRange('dof-blur', () => state.dof.blur, (v) => { state.dof.blur = v; syncFocusUI(); scheduleAutosave(); }, (v) => (v === 0 ? 'off' : v.toFixed(1))),
  bindRange('dof-distance', () => clamp(focusDistance(), 0.2, 30), (v) => {
    const d = state.dof;
    d.bone = ''; d.distance = v;
    if (d.keys.length) keyFocus(v); else { syncFocusUI(); scheduleAutosave(); }
  }, (v) => `${v.toFixed(2)} m`),
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
  $('scn-weather').value = state.scene.weather || 'clear';
  $('look-preset').value = state.look.preset in LOOKS ? state.look.preset : 'none';
  $('look-keepred').checked = !!state.look.keepRed;
  $('look-wet').checked = !!state.look.wet;
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
$('scn-weather').replaceChildren(new Option('Clear', 'clear'), ...Object.entries(WEATHER).filter(([, w]) => w).map(([id, w]) => new Option(w.label, id)));
function setLook(change) {
  if (change.preset !== undefined) {
    if (!(change.preset in LOOKS)) throw new Error(`look must be one of ${Object.keys(LOOKS).join(', ')}`);
    const { label, ...values } = LOOKS[change.preset];
    Object.assign(state.look, values, { tint: [...values.tint] });
  }
  const { preset, ...rest } = change;
  Object.assign(state.look, rest);
  applyScene();
  syncInspector();
  scheduleAutosave();
}
$('look-preset').replaceChildren(...Object.entries(LOOKS).map(([id, l]) => new Option(l.label, id)));
$('look-preset').addEventListener('change', (e) => setLook({ preset: e.target.value }));
$('look-keepred').addEventListener('change', (e) => setLook({ keepRed: e.target.checked }));
$('look-wet').addEventListener('change', (e) => setLook({ wet: e.target.checked }));
$('scn-weather').addEventListener('change', (e) => { state.scene.weather = e.target.value; applyScene(); scheduleAutosave(); });
async function importSky(file) {
  const url = URL.createObjectURL(file);
  try {
    const hdr = /\.hdr$/i.test(file.name);
    const texture = await (hdr ? new RGBELoader() : new THREE.TextureLoader()).loadAsync(url);
    if (!hdr) texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    skyImage?.dispose();
    skyImage = texture;
    applyScene();
    setStatus(`Sky image ${file.name} loaded. It lights the scene too; the sun still adds its own light.`);
  } catch (err) { setStatus(`Could not read ${file.name}: ${err.message}`); } finally { URL.revokeObjectURL(url); }
}
$('btn-sky').addEventListener('click', () => $('file-sky').click());
$('file-sky').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSky(f); });
$('btn-sky-clear').addEventListener('click', () => { skyImage?.dispose(); skyImage = null; applyScene(); setStatus('Sky image removed'); });
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
  if (typing(e)) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyZ') { e.preventDefault(); stepHistory(e.shiftKey ? 1 : -1); }
    else if (e.code === 'KeyY') { e.preventDefault(); stepHistory(1); }
    return;
  }
  if (!$('viewer').hidden) { if (e.code === 'Escape') $('viewer').hidden = true; return; }
  const frame = 1 / state.fps;
  switch (e.code) {
    case 'Tab': e.preventDefault(); setMode(mode === 'camera' ? 'free' : 'camera'); break;
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'KeyK': setKeyNow(); break;
    case 'KeyP': keyPose(); break;
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
    app: 'cinematic', version: 2,
    duration: state.duration, fps: state.fps, time: state.time, loop: state.loop, autoKey: state.autoKey,
    markers: state.markers, scene: state.scene, pose: state.pose, poseKeys: state.poseKeys, look: state.look, dof: state.dof, queue: jobs.map((j) => ({ ...j, status: j.status === 'rendering' ? 'waiting' : j.status })), mount: state.mount, anim: state.anim, next: state.next, chain: state.chain, props: state.props,
    camera: { keys: track.toJSON(), rest: { pos: camLocal.position.toArray(), quat: camLocal.quaternion.toArray(), fov: shotCam.fov } },
    actor: { name: actors[1].name, pos: actorRoot.position.toArray(), quat: actorRoot.quaternion.toArray() },
  };
}

function load(data) {
  if (!data || data.app !== 'cinematic') throw new Error('Not a Cinematic project file');
  const d = defaults();
  Object.assign(state, d, {
    duration: data.duration ?? d.duration, fps: data.fps ?? d.fps, time: 0, loop: !!data.loop, autoKey: !!data.autoKey,
    markers: data.markers ?? [], scene: { ...d.scene, ...data.scene }, pose: (data.version ?? 1) >= 2 ? { ...(data.pose ?? {}) } : {}, poseKeys: Array.isArray(data.poseKeys) ? data.poseKeys.map((k) => ({ t: k.t, pose: { ...k.pose } })).sort((x, y) => x.t - y.t) : [],
    look: { ...d.look, ...data.look, tint: [...(data.look?.tint ?? d.look.tint)] },
    dof: { ...d.dof, ...data.dof, keys: Array.isArray(data.dof?.keys) ? data.dof.keys.map((k) => ({ t: k.t, distance: k.distance })).sort((x, y) => x.t - y.t) : [] },
    mount: { ...d.mount, ...data.mount }, anim: { ...d.anim, ...data.anim }, next: { ...d.next, ...data.next }, chain: Array.isArray(data.chain) ? data.chain.map((c) => ({ ...c })) : [],
    props: Array.isArray(data.props) ? data.props.map((p) => ({ name: p.name, bone: p.bone ?? null, hidden: [...(p.hidden ?? [])] })) : [],
  });
  legacyPose = (data.version ?? 1) < 2 && data.pose && Object.keys(data.pose).length ? data.pose : null;
  if (legacyPose && bindPose.size) collectBones();
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
  syncAnimUI();
  poseDirty = false;
  rebuildPoseKeys();
  syncPoseUI();
  if (!rendering) {                                    // the render queue travels with the project; a job cut off mid-render waits again
    jobs.splice(0, jobs.length, ...(Array.isArray(data.queue) ? data.queue : []).map((j) => ({ ...j, status: j.status === 'rendering' ? 'waiting' : j.status })));
    jobSeq = Math.max(jobSeq, 0, ...jobs.map((j) => j.id || 0));
    syncQueueUI();
  }
  for (const prop of props) {                          // apply saved settings to props that are loaded in this session
    const saved = state.props.find((p) => p.name === prop.name);
    if (!saved) continue;
    prop.hidden = new Set(saved.hidden);
    placeProp(prop, saved.bone);
    applyPropParts(prop);
  }
  syncPropsUI();
  applyScene();
  setTime(data.time ?? 0);
  keysChanged();
  resize();
}

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, 600);
}
function flushAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  const data = serialise(), json = JSON.stringify(data);
  recordHistory(data, json);
  try { localStorage.setItem(AUTOSAVE_KEY, json); } catch { /* storage unavailable: nothing to do */ }
}

// ---- undo and redo: every settled change is a step; the playhead and the render queue are not part of a step
const history = [];
let historyAt = -1;
function recordHistory(data, json) {
  const key = JSON.stringify({ ...data, time: 0, queue: null });
  if (historyAt >= 0 && history[historyAt].key === key) return;
  history.splice(historyAt + 1);
  history.push({ key, json });
  if (history.length > 200) history.shift();
  historyAt = history.length - 1;
  syncUndoUI();
}
function stepHistory(by) {
  if (rendering) return;
  if (autosaveTimer) flushAutosave();                  // a change still settling becomes its own step first
  const to = historyAt + by;
  if (to < 0 || to >= history.length) return;
  historyAt = to;
  const data = JSON.parse(history[to].json), time = state.time;
  data.queue = serialise().queue;
  load(data);
  setTime(Math.min(time, state.duration));
  syncUndoUI();
  setStatus(by < 0 ? 'Undone' : 'Redone');
}
function syncUndoUI() {
  $('btn-undo').disabled = historyAt <= 0;
  $('btn-redo').disabled = historyAt >= history.length - 1;
}
$('btn-undo').addEventListener('click', () => stepHistory(-1));
$('btn-redo').addEventListener('click', () => stepHistory(1));

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
  jobs.length = 0; syncQueueUI();
  applyScene(); setTime(0); keysChanged(); resize(); syncPoseUI();
  setStatus('New project');
});

// ------------------------------------------------------------------ model import (files stay on this computer)
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  importFiles(files);
});

/** Ask which of several models in a folder to load. Resolves to the chosen name, or null if cancelled. */
function chooseModel(names) {
  return new Promise((resolve) => {
    const dialog = $('chooser'), list = $('chooser-list');
    list.replaceChildren(...names.map((n) => {
      const b = document.createElement('button');
      b.textContent = n;
      b.addEventListener('click', () => { dialog.close(); resolve(n); });
      return b;
    }));
    dialog.addEventListener('close', () => resolve(null), { once: true });
    dialog.showModal();
  });
}

function dataTexture(image, srgb) {
  const t = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Wire up textures for a model straight from the ripper's output: <model>_textures.txt says which image each
 * material uses, and the images are .dds files anywhere in the picked folder. Returns how many maps were set.
 */
async function bindRippedTextures(root, modelName, files) {
  const listFile = files.find((f) => f.name.toLowerCase() === `${modelName.toLowerCase()}_textures.txt`);
  if (!listFile) return 0;
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const wanted = {};                                    // material name -> { 2: colour, 5: normal, 8: specular }
  for (const line of (await listFile.text()).split(/\r?\n/)) {
    const part = line.split('\t');
    if (part.length !== 3) continue;
    (wanted[part[0]] ||= {})[Number(part[1].split('=')[1])] = part[2].replace(/^images\//, '').replace(/\.iwi$/i, '');
  }
  const made = new Map();
  const decode = async (image) => {
    const file = byName.get(`${image.toLowerCase()}.dds`);
    return file ? decodeDDS(new Uint8Array(await file.arrayBuffer())) : null;
  };
  // `camo` is the name of a weapon camo pattern to paint onto a colour map, or undefined
  const texture = async (image, kind, camo) => {
    const key = `${kind}:${image}:${camo || ''}`;
    if (made.has(key)) return made.get(key);
    let out = null;
    try {
      const pixels = await decode(image);
      if (pixels) {
        if (kind === 'normal') gameNormalToStandard(pixels);
        if (kind === 'rough') gameSpecToRoughness(pixels);
        if (kind === 'colour' && camo) { const pattern = await decode(camo); if (pattern) applyCamo(pixels, pattern); }
        out = dataTexture(pixels, kind === 'colour');
      }
    } catch { out = null; }
    made.set(key, out);
    return out;
  };
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  let bound = 0;
  for (const mesh of meshes) {
    const m = mesh.material, w = wanted[m.name];
    if (!w) continue;
    const camo = w[3] && /^weapon_camo/i.test(w[3]) ? w[3] : undefined;      // slot 3 holds the camo pattern on painted weapons
    if (!m.map && w[2]) { const t = await texture(w[2], 'colour', camo); if (t) { m.map = t; m.color.set(0xffffff); bound++; } }
    if (!m.normalMap && w[5]) { const t = await texture(w[5], 'normal'); if (t) { m.normalMap = t; bound++; } }
    if (!m.roughnessMap && w[8]) { const t = await texture(w[8], 'rough'); if (t) { m.roughnessMap = t; m.roughness = 1; bound++; } }
    m.needsUpdate = true;
  }
  return bound;
}

/** Load one model from a picked folder. Returns { scene, name, note } or null if nothing was loaded. */
async function loadModelFolder(files, preferName) {
  const models = files.filter((f) => /\.(glb|gltf)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!models.length) { setStatus('No .glb or .gltf file in that folder'); return null; }
  const base = (f) => f.name.replace(/\.(glb|gltf)$/i, '');
  let main = models[0];
  if (preferName) main = models.find((f) => base(f) === preferName) || null;
  else if (models.length > 1) { const picked = await chooseModel(models.map(base)); main = picked ? models.find((f) => base(f) === picked) : null; }
  if (!main) { setStatus(preferName ? `No model named ${preferName} in that folder` : 'Nothing chosen'); return null; }
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
    const bound = await bindRippedTextures(gltf.scene, base(main), files);
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
    const note = (bound ? ` · ${bound} texture map(s) wired from the ripper's list` : '') + (missing ? ` · ${missing} texture(s) not found in the folder` : '');
    return { scene: gltf.scene, name: base(main), note };
  } catch (err) {
    setStatus(`Could not load ${main.name}: ${err.message}`);
    return null;
  }
}

async function importFiles(files, preferName) {
  const loaded = await loadModelFolder(files, preferName);
  if (!loaded) return;
  for (const prop of props) placeProp(prop, null);       // props ride on bones that are about to be replaced
  actorRoot.clear();
  actorRoot.add(loaded.scene);
  collectBones();
  applyPose();
  for (const prop of props) placeProp(prop, prop.bone);
  setPoseBone(null);
  syncMountUI();
  syncPropsUI();
  actors[1].name = loaded.name;
  rebuildActors();
  setStatus(`Loaded ${loaded.name}${loaded.note}`);
}

// ------------------------------------------------------------------ props (a weapon in the hand, anything attached to a bone)
const props = [];
// ---- maps: the environment ripped from the game, loaded as scenery
const mapRoot = new THREE.Group();
scene.add(mapRoot);
let mapName = null;
/** How a map material should be drawn, judged from its name (the game's own material settings are not exported). */
function mapMaterialKind(name) {
  const n = name.toLowerCase().split('/').pop();
  if (/^(shadowcaster|clip|caulk|nodraw|portal|trigger|hint|lightgrid|reflection)/.test(n) || /^tools?_/.test(n)) return 'hidden';
  if (/glass/.test(n)) return 'glass';
  if (/fence|wire|grate|chainlink|foliage|leaf|branch|grass/.test(n) && !/decal/.test(n)) return 'cutout';
  if (/decal|_dec_|stain|grime|prints|puddle|leak|cracks|papers|frost|tireskid|drawing/.test(n)) return 'decal';
  return 'solid';
}

const cutoutChecked = new WeakMap();
async function importMap(files, preferName) {
  const loaded = await loadModelFolder(files, preferName);
  if (!loaded) return null;
  mapRoot.clear();
  mapRoot.add(loaded.scene);
  let meshes = 0;
  loaded.scene.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    o.castShadow = true; o.receiveShadow = true;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      let kind = mapMaterialKind(m.name);
      if (kind === 'solid' && /^mc\//.test(m.name) && m.map?.image?.data) {   // placed models (trees, bushes, fences): see-through parts are in the texture
        if (!cutoutChecked.has(m)) {
          const d = m.map.image.data, step = Math.max(4, Math.floor(d.length / 4 / 4000) * 4);
          let clear = 0, n = 0;
          for (let i = 3; i < d.length; i += step) { n++; if (d[i] < 40) clear++; }
          cutoutChecked.set(m, clear / n > 0.04);
        }
        if (cutoutChecked.get(m)) kind = 'cutout';
      }
      if (kind === 'hidden') { o.visible = false; continue; }
      if (kind === 'decal') {                              // stains, prints, lettering: laid over the surface beneath
        Object.assign(m, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, alphaTest: 0.02 });
        o.castShadow = false; o.renderOrder = 2;
      } else if (kind === 'cutout') { m.alphaTest = 0.5; m.transparent = false; m.alphaToCoverage = true; }   // fences, wires, grates
      else if (kind === 'glass') { Object.assign(m, { transparent: true, opacity: 0.35, depthWrite: false, roughness: 0.1 }); o.castShadow = false; o.renderOrder = 3; }
      for (const key of ['map', 'normalMap', 'roughnessMap']) if (m[key]) { m[key].wrapS = m[key].wrapT = THREE.RepeatWrapping; m[key].needsUpdate = true; }   // world textures tile
    }
  });
  mapName = loaded.name;
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, far: 220 });   // shadows cover the buildings around him, not just him
  sun.shadow.camera.updateProjectionMatrix();
  applyScene();
  const box = new THREE.Box3().setFromObject(mapRoot), centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  orbit.target.copy(centre);
  freeCam.position.copy(centre).add(new THREE.Vector3(0.25, 0.35, 0.25).multiplyScalar(Math.max(size.x, size.z)));
  freeCam.far = Math.max(freeCam.far, size.length() * 3); freeCam.updateProjectionMatrix();
  shotCam.far = Math.max(shotCam.far, size.length() * 3); shotCam.updateProjectionMatrix();
  setMode('free');
  setStatus(`Added map ${loaded.name} (${meshes} parts, ${Math.round(size.x)} × ${Math.round(size.z)} m). Aim the view at a spot and press Place actor here.`);
  return loaded.name;
}
const _ray = new THREE.Raycaster();
/** Stand the character on whatever the middle of the current view is looking at (map or ground). */
function placeActorAtView() {
  const cam = mode === 'camera' ? shotCam : freeCam;
  _ray.setFromCamera(new THREE.Vector2(0, 0), cam);
  const hit = _ray.intersectObjects(mapName ? [mapRoot] : [ground], true)[0];
  if (!hit) { setStatus('Nothing under the middle of the view to stand him on'); return false; }
  actorRoot.position.copy(hit.point);
  applyTrack();
  scheduleAutosave();
  setStatus(`Actor placed at ${hit.point.toArray().map((v) => v.toFixed(1)).join(', ')}`);
  return true;
}
$('btn-import-map').addEventListener('click', () => $('file-map').click());
$('file-map').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; importMap(files); });
$('btn-place-actor').addEventListener('click', placeActorAtView);

const propWorld = new THREE.Group();                     // where unattached props and all prop meshes live
scene.add(propWorld);
const HIDDEN_BY_DEFAULT = /acog|thermal|suppress|silenc|motion_tracker|heartbeat|laser|reflex|eotech|holo|grenad|shotgun|foregrip|_grip|tactical|akimbo|fmj|xmag/i;
const PREFERRED_PROP_BONES = ['tag_weapon_right', 'j_gun', 'tag_weapon', 'j_wrist_ri'];

$('btn-import-prop').addEventListener('click', () => $('file-prop').click());
$('file-prop').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  importProp(files);
});

async function importProp(files, preferName) {
  const loaded = await loadModelFolder(files, preferName);
  if (!loaded) return null;
  const old = props.find((p) => p.name === loaded.name);
  if (old) removeProp(old);
  // The file's top node converts the game's units and axes to the scene's. Its children are the model itself in the
  // game's own space, which is also the space of the bone it attaches to, so they can ride a bone with no offset.
  const holder = loaded.scene.children.find((c) => !c.isMesh) || loaded.scene;
  const carrier = new THREE.Group();
  const unit = new THREE.Group();
  unit.quaternion.copy(holder.quaternion);
  unit.scale.copy(holder.scale);
  for (const child of [...holder.children]) carrier.add(child);
  const skinned = new THREE.Group();
  for (const child of [...loaded.scene.children]) if (child !== holder) skinned.add(child);
  propWorld.add(unit, skinned);
  const prop = { name: loaded.name, bone: null, carrier, unit, skinned, parts: new Map(), hidden: new Set() };
  for (const root of [carrier, skinned]) root.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.material.name || 'unnamed';
    if (!prop.parts.has(key)) prop.parts.set(key, []);
    prop.parts.get(key).push(o);
  });
  const saved = state.props.find((p) => p.name === prop.name);
  for (const part of prop.parts.keys()) if (saved ? saved.hidden.includes(part) : HIDDEN_BY_DEFAULT.test(part)) prop.hidden.add(part);
  props.push(prop);
  placeProp(prop, saved ? saved.bone : PREFERRED_PROP_BONES.find((b) => bones[b]) || null);
  applyPropParts(prop);
  storeProps();
  syncPropsUI();
  setStatus(`Added ${prop.name}${prop.bone ? ` on ${prop.bone}` : ' (not attached: import a rigged character first)'}${loaded.note}`);
  return prop;
}

/** Attach a prop to one of the actor's bones, or leave it free in the scene when bone is null. */
function placeProp(prop, bone) {
  prop.bone = bone && bones[bone] ? bone : null;
  (prop.bone ? bones[prop.bone] : prop.unit).add(prop.carrier);
}

function applyPropParts(prop) {
  for (const [part, meshes] of prop.parts) for (const mesh of meshes) mesh.visible = !prop.hidden.has(part);
}

function removeProp(prop) {
  prop.carrier.removeFromParent();
  propWorld.remove(prop.unit, prop.skinned);
  props.splice(props.indexOf(prop), 1);
  storeProps();
  syncPropsUI();
}

function storeProps() {
  const loaded = props.map((p) => ({ name: p.name, bone: p.bone, hidden: [...p.hidden] }));
  const others = state.props.filter((s) => !props.some((p) => p.name === s.name));      // keep settings for props not loaded right now
  state.props = [...loaded, ...others];
  scheduleAutosave();
}

function syncPropsUI() {
  const host = $('props-list'), names = Object.keys(bones).sort();
  host.replaceChildren(...props.map((prop) => {
    const box = document.createElement('div');
    box.className = 'prop';
    const head = document.createElement('div');
    head.className = 'prop-head';
    const title = document.createElement('strong');
    title.textContent = prop.name;
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeProp(prop));
    head.append(title, remove);
    const row = document.createElement('label');
    row.className = 'row';
    const span = document.createElement('span');
    span.textContent = 'Attached to';
    const sel = document.createElement('select');
    sel.replaceChildren(new Option('Nothing (free in the scene)', ''), ...names.map((n) => new Option(n, n)));
    sel.value = prop.bone || '';
    sel.addEventListener('change', () => { placeProp(prop, sel.value || null); storeProps(); });
    row.append(span, sel);
    const parts = document.createElement('div');
    parts.className = 'prop-parts';
    for (const part of [...prop.parts.keys()].sort()) {
      const label = document.createElement('label');
      label.className = 'row check';
      const box2 = document.createElement('input');
      box2.type = 'checkbox';
      box2.checked = !prop.hidden.has(part);
      box2.addEventListener('change', () => {
        if (box2.checked) prop.hidden.delete(part); else prop.hidden.add(part);
        applyPropParts(prop);
        storeProps();
      });
      const text = document.createElement('span');
      text.textContent = part.split('/').pop().replace(/^mtl_/, '').replace(/_/g, ' ');
      label.append(box2, text);
      parts.append(label);
    }
    box.append(head, row, parts);
    return box;
  }));
  const waiting = state.props.filter((s) => !props.some((p) => p.name === s.name)).map((s) => s.name);
  $('props-info').textContent = props.length || waiting.length
    ? (waiting.length ? `Not loaded in this session: ${waiting.join(', ')}. Import them again to see them.` : '')
    : 'Nothing attached. Use Import prop to add a weapon or other model.';
}

// ------------------------------------------------------------------ animations
$('btn-import-anim').addEventListener('click', () => $('file-anim').click());
$('file-anim').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  setStatus(await importAnimations(files));
});

/** Load .anim.json files into the library. Returns a sentence describing what happened. */
async function importAnimations(files) {
  let added = 0, bad = 0, unnamed = 0, last = null;
  for (const file of files) {
    try {
      const clip = new Clip(JSON.parse(await file.text()));
      clipLibrary.set(clip.name, clip);
      added++; last = clip;
      if (clip.unnamed) unnamed++;
    } catch { bad++; }
  }
  if (added && !activeClip()) setAnimation({ name: last.name, loop: last.loop });
  syncAnimUI();
  if (!added) return bad ? 'None of those files were animation exports' : 'No files chosen';
  const fit = last && Object.keys(bones).length ? ` · ${last.bones.filter((b) => bones[b.name]).length} of ${last.bones.length} bones match this model` : '';
  return `Imported ${added} animation(s)${bad ? `, skipped ${bad} other file(s)` : ''}${fit}`
    + (unnamed ? ` · ${unnamed} have placeholder bone names and cannot drive a model` : '');
}

/** Replace the list of animations that follow the second one. */
function setChain(list) {
  state.chain = list.filter((c) => c && c.name).map((c) => ({
    name: c.name, at: clamp(Number(c.at) || 0, 0, state.duration), blend: clamp(Number(c.blend ?? 0.25) || 0, 0, 2),
    speed: clamp(Number(c.speed) || 1, 0.05, 4), loop: c.loop ?? (clipLibrary.get(c.name)?.loop || false),
  }));
  syncAnimUI();
  scheduleAutosave();
}

function setNext(next) {
  Object.assign(state.next, next);
  if (state.next.name && !clipLibrary.has(state.next.name)) state.next.name = null;
  state.next.at = clamp(Number(state.next.at) || 0, 0, state.duration);
  state.next.blend = clamp(Number(state.next.blend) || 0, 0, 2);
  state.next.speed = clamp(Number(state.next.speed) || 1, 0.05, 4);
  syncAnimUI();
  scheduleAutosave();
}

function setAnimation(next) {
  Object.assign(state.anim, next);
  if (state.anim.name && !clipLibrary.has(state.anim.name)) state.anim.name = null;
  state.anim.speed = clamp(Number(state.anim.speed) || 1, 0.05, 4);
  state.anim.start = clamp(Number(state.anim.start) || 0, 0, state.duration);
  syncAnimUI();
  scheduleAutosave();
}

function syncAnimUI() {
  const sel = $('anim-clip'), names = [...clipLibrary.keys()].sort();
  sel.replaceChildren(new Option(names.length ? 'None' : 'None (import animations first)', ''), ...names.map((n) => new Option(n, n)));
  sel.value = activeClip() ? state.anim.name : '';
  sel.disabled = !names.length;
  $('anim-start').value = state.anim.start;
  $('anim-speed').value = state.anim.speed;
  $('anim-speed-out').textContent = `${state.anim.speed.toFixed(2)}×`;
  $('anim-loop').checked = state.anim.loop;
  $('anim-travel').checked = state.anim.travel;
  $('anim-ground').checked = state.anim.ground !== false;
  const then = $('anim-next');
  then.replaceChildren(new Option('Nothing', ''), ...names.map((n) => new Option(n, n)));
  then.value = nextClip() ? state.next.name : '';
  then.disabled = !activeClip();
  $('anim-next-at').value = state.next.at;
  $('anim-next-blend').value = state.next.blend;
  $('anim-chain').replaceChildren(...state.chain.map((c, n) => {
    const row = document.createElement('div');
    row.className = 'chain-row';
    const pick = document.createElement('select');
    pick.replaceChildren(...names.map((x) => new Option(x, x)));
    if (!names.includes(c.name)) pick.add(new Option(`${c.name} (not loaded)`, c.name));
    pick.value = c.name;
    const edit = (change) => setChain(state.chain.map((x, m) => (m === n ? { ...x, ...change } : x)));
    pick.addEventListener('change', () => edit({ name: pick.value, loop: undefined }));
    const num = (value, title, key) => {
      const input = document.createElement('input');
      input.type = 'number'; input.step = '0.05'; input.min = '0'; input.value = value; input.title = title;
      input.addEventListener('change', () => edit({ [key]: Number(input.value) }));
      return input;
    };
    const remove = document.createElement('button');
    remove.textContent = '✕'; remove.title = 'Remove this animation';
    remove.addEventListener('click', () => setChain(state.chain.filter((_, m) => m !== n)));
    row.append(pick, num(c.at, 'Takes over at (seconds)', 'at'), num(c.blend, 'Blend over (seconds)', 'blend'), remove);
    return row;
  }));
  $('btn-chain-add').disabled = !nextClip();
  const clip = activeClip();
  $('anim-info').textContent = clip
    ? `${clip.duration.toFixed(2)} s at ${clip.framerate} fps · ${clip.bones.length} bones${clip.loop ? ' · made to loop' : ''}`
      + (clip.root ? ` · travels ${(clip.travelPerPass * 0.0254).toFixed(1)} m per pass` : ' · stays in place (no travel data in this file)')
    : (state.anim.name ? `"${state.anim.name}" is not loaded. Import it again to see it play.` : '');
  rebuildAnimBar();
}

function rebuildPoseKeys() {
  $('tl-pose').replaceChildren(...state.poseKeys.map((k) => {
    const d = document.createElement('div');
    d.className = 'tl-key pose';
    d.style.left = `${xOf(k.t)}px`;
    d.title = `Pose key at ${k.t}s · click to go there · Shift-click to delete`;
    d.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.addEventListener('click', (e) => { if (e.shiftKey) deletePoseKey(k); else setTime(k.t); });
    return d;
  }));
}

function syncPoseUI() {
  const names = Object.keys(bones).sort(), sel = $('pose-bone');
  if (sel.options.length !== names.length + 1) sel.replaceChildren(new Option(names.length ? 'None' : 'None (import a rigged model)', ''), ...names.map((n) => new Option(n, n)));
  sel.value = poseBoneName || '';
  sel.disabled = !names.length;
  const posed = Object.keys(state.pose).length;
  syncFocusUI();
  $('pose-info').textContent = `${posed} bone(s) posed · ${state.poseKeys.length} pose key(s)` + (poseDirty ? ' · changed, not keyed' : '');
}

function rebuildAnimBar() {
  const row = $('tl-anim'), clip = activeClip();
  row.replaceChildren();
  if (!clip) return;
  const length = clip.duration / state.anim.speed;
  const end = state.anim.loop ? state.duration : Math.min(state.duration, state.anim.start + length);
  const bar = document.createElement('div');
  bar.className = 'tl-clip';
  bar.style.left = `${xOf(state.anim.start)}px`;
  bar.style.width = `${Math.max(2, xOf(end) - xOf(state.anim.start))}px`;
  bar.textContent = clip.name;
  bar.title = `${clip.name} · ${length.toFixed(2)} s per pass`;
  row.append(bar);
  const seq = clipSequence();
  seq.slice(1).forEach((item, n) => {                           // the animations that take over, in order
    const following = seq[n + 2];
    if (n === 0) bar.style.width = `${Math.max(2, xOf(Math.min(end, item.at + item.blend)) - xOf(state.anim.start))}px`;
    const length2 = item.clip.duration / item.speed;
    let end2 = item.loop ? state.duration : Math.min(state.duration, item.at + length2);
    if (following) end2 = Math.min(end2, following.at + following.blend);
    const bar2 = document.createElement('div');
    bar2.className = `tl-clip ${n % 2 ? '' : 'second'}`;
    bar2.style.left = `${xOf(item.at)}px`;
    bar2.style.width = `${Math.max(2, xOf(end2) - xOf(item.at))}px`;
    bar2.textContent = item.clip.name;
    bar2.title = `${item.clip.name} takes over at ${item.at.toFixed(2)} s, blending for ${item.blend.toFixed(2)} s`;
    row.append(bar2);
  });
  const lastRepeat = seq[1] ? seq[1].at : state.duration;
  if (state.anim.loop && length > 0.05) {                       // a tick where each repeat begins
    for (let t = state.anim.start + length; t < lastRepeat - 1e-6; t += length) {
      const tick = document.createElement('div');
      tick.className = 'tl-clip-tick';
      tick.style.left = `${xOf(t)}px`;
      row.append(tick);
    }
  }
}

$('pose-bone').addEventListener('change', (e) => { if (e.target.value && mode !== 'free') setMode('free'); setPoseBone(e.target.value || null); });
$('btn-pose-key').addEventListener('click', () => keyPose());
$('dof-bone').addEventListener('change', (e) => { state.dof.bone = e.target.value; syncFocusUI(); syncInspector(); scheduleAutosave(); });
$('btn-dof-key').addEventListener('click', () => { keyFocus(); syncInspector(); });
$('btn-dof-clear').addEventListener('click', () => { state.dof.keys = []; syncFocusUI(); scheduleAutosave(); });
$('btn-pose-clear').addEventListener('click', () => { clearPose(); applyPose(); });

$('anim-clip').addEventListener('change', (e) => {
  const clip = clipLibrary.get(e.target.value);
  setAnimation({ name: e.target.value || null, ...(clip ? { loop: clip.loop } : {}) });
});
$('anim-start').addEventListener('change', (e) => setAnimation({ start: Number(e.target.value) }));
$('anim-speed').addEventListener('input', (e) => setAnimation({ speed: Number(e.target.value) }));
$('anim-loop').addEventListener('change', (e) => setAnimation({ loop: e.target.checked }));
$('anim-travel').addEventListener('change', (e) => setAnimation({ travel: e.target.checked }));
$('anim-ground').addEventListener('change', (e) => setAnimation({ ground: e.target.checked }));
$('anim-next').addEventListener('change', (e) => {
  const clip = clipLibrary.get(e.target.value);
  setNext({ name: e.target.value || null, ...(clip ? { loop: clip.loop } : {}) });
});
$('btn-chain-add').addEventListener('click', () => {
  const name = [...clipLibrary.keys()].sort()[0];
  const lastAt = Math.max(state.next.at, ...state.chain.map((c) => c.at));
  if (name) setChain([...state.chain, { name, at: Math.min(state.duration, lastAt + 1), blend: 0.25 }]);
});
$('anim-next-at').addEventListener('change', (e) => setNext({ at: Number(e.target.value) }));
$('anim-next-blend').addEventListener('change', (e) => setNext({ blend: Number(e.target.value) }));

// ------------------------------------------------------------------ render queue
const jobs = [];
let rendering = false, queueStop = false, jobSeq = 0;

function addJob(options = {}) {
  const [width, height] = (options.size || $('q-size').value).split('x').map(Number);
  const from = clamp(Number(options.from ?? $('q-from').value) || 0, 0, state.duration);
  const to = clamp(Number(options.to ?? $('q-to').value) || state.duration, 0, state.duration);
  const job = {
    id: ++jobSeq,
    name: safeName(options.name ?? $('q-name').value),
    from: Math.min(from, to), to: Math.max(from, to), width, height,
    fps: Number(options.fps ?? $('q-fps').value),
    format: options.format ?? $('q-format').value,
    samples: Number(options.samples ?? $('q-blur').value),
    background: options.background ?? $('q-bg').value,
    depth: options.depth ?? $('q-depth').checked,
    depthRange: clamp(Number(options.depthRange ?? $('q-depth-range').value) || 25, 1, 1000),
    status: 'waiting', done: 0, total: 0, note: '',
  };
  if (job.format !== 'png') { job.background = 'scene'; job.depth = false; }       // video cannot carry transparency or a second pass
  job.total = frameTimes(job.from, job.to, job.fps).length;
  jobs.push(job);
  syncQueueUI();
  scheduleAutosave();
  return job;
}

function syncQueueUI() {
  $('q-list').replaceChildren(...jobs.map((job) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = job.name;
    const detail = document.createElement('span');
    detail.textContent = `${job.width}×${job.height} · ${job.fps} fps · ${job.format === 'mp4' ? 'MP4' : 'PNG frames'}`
      + `${job.samples > 1 ? ` · blur ×${job.samples}` : ''}${job.background === 'transparent' ? ' · transparent' : ''}${job.depth ? ' · depth pass' : ''} · ${job.from.toFixed(2)}–${job.to.toFixed(2)} s`;
    const state2 = document.createElement('em');
    state2.textContent = job.status === 'rendering' ? `frame ${job.done} of ${job.total}${job.note}`
      : job.status === 'waiting' ? (job.done > 0 && job.format === 'png' ? `waiting, picks up at frame ${job.done + 1} of ${job.total}` : `${job.total} frames, waiting`) : `${job.status}${job.note}`;
    text.append(title, detail, state2);
    const bar = document.createElement('div');
    bar.className = 'q-bar';
    bar.style.setProperty('--done', `${job.total ? (100 * job.done) / job.total : 0}%`);
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove from the queue';
    remove.disabled = job.status === 'rendering';
    remove.addEventListener('click', () => { jobs.splice(jobs.indexOf(job), 1); syncQueueUI(); scheduleAutosave(); });
    const side = document.createElement('div');
    side.className = 'q-side';
    if (job.status === 'stopped' || job.status === 'failed') {
      const again = document.createElement('button');
      again.textContent = '↻';
      again.title = job.format === 'png' && job.done > 0 ? 'Carry on from the last finished frame (choose the same folder)' : 'Render this job again';
      again.disabled = rendering;
      again.addEventListener('click', () => { job.status = 'waiting'; job.note = ''; if (job.format !== 'png') job.done = 0; syncQueueUI(); scheduleAutosave(); });
      side.append(again);
    }
    side.append(remove);
    li.append(text, side, bar);
    return li;
  }));
  const waiting = jobs.some((j) => j.status === 'waiting');
  $('btn-q-start').disabled = rendering || !waiting;
  $('btn-q-stop').disabled = !rendering;
  $('btn-q-add').disabled = rendering;
  $('q-info').textContent = jobs.length ? '' : 'Nothing queued. Set up a shot, choose the output below and press Add to queue.';
}

function deliver(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/** Render one job frame by frame. Each frame is drawn at its exact time, so speed of the machine does not matter. */
async function runJob(job, hooks) {
  const { width, height } = job;
  if (job.format === 'mp4' && !(await canMakeMp4(width, height))) {
    job.status = 'failed'; job.note = ': this browser cannot encode H.264 video at this size; use PNG frames';
    return;
  }
  const accum = document.createElement('canvas');
  accum.width = width; accum.height = height;
  const ctx = accum.getContext('2d');
  const transparent = job.background === 'transparent';
  const total = state.dof.blur > 0 ? Math.max(job.samples, DOF_SAMPLES) : job.samples;      // samples averaged per frame
  const acc = total > 1 || transparent ? makeAccumulator(width, height) : null;
  if (acc) acc.plain = transparent;                    // the look's glow and grade need a background, so cut-outs stay plain
  let depthCanvas = null, depthSink = null;
  if (job.depth) {
    depthCanvas = document.createElement('canvas');
    depthCanvas.width = width; depthCanvas.height = height;
    depthSink = createPngSink(depthCanvas, `${job.name}_depth`, hooks.writeFile);
  }
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, width, height);
  shotCam.aspect = width / height;
  shotCam.updateProjectionMatrix();
  setOverlays(false);
  const sink = job.format === 'mp4' ? await createMp4Sink(accum, job.fps) : createPngSink(accum, job.name, hooks.writeFile);
  const times = frameTimes(job.from, job.to, job.fps);
  const started = performance.now();
  const first = job.format === 'png' && job.done > 0 && job.done < times.length ? job.done : 0;   // carry on where a cut-off image sequence stopped
  job.status = 'rendering';
  job.done = first;
  if (transparent) { skyDome.visible = false; scene.background = null; scene.fog = null; renderer.setClearColor(0x000000, 0); ground.visible = false; grid.visible = false; }
  try {
    for (let i = first; i < times.length; i++) {
      if (queueStop) { job.status = 'stopped'; await sink.cancel(); return; }
      state.time = times[i];                         // exact time, not snapped to the timeline's frame grid
      camDirty = false;
      poseDirty = false;
      if (acc) {                                     // average sub-frames (motion blur) and lens points (depth of field)
        renderSamples(acc, total, job.samples > 1 ? subframeTimes(times[i], job.fps, total) : Array(total).fill(times[i]));
        resolveTo(ctx, acc, total, transparent);
      } else {
        applyTrack();
        renderShot(shotCam);
        ctx.drawImage(canvas, 0, 0);
      }
      await sink.add(i);
      if (depthSink) {
        state.time = times[i];
        applyTrack();
        setDepthLook(true, job.depthRange);
        try { renderer.render(scene, shotCam); } finally { setDepthLook(false); }
        depthCanvas.getContext('2d').drawImage(canvas, 0, 0);
        await depthSink.add(i);
      }
      job.done = i + 1;
      if (job.format === 'png' && i % 30 === 29) scheduleAutosave();      // so a crash can pick up near here
      const left = ((performance.now() - started) / (i + 1 - first)) * (times.length - i - 1) / 1000;
      job.note = left > 1 ? ` · about ${left > 90 ? `${Math.round(left / 60)} min` : `${Math.round(left)} s`} left` : '';
      if (i % 4 === 0) { syncQueueUI(); await new Promise((r) => setTimeout(r, 0)); }     // let the Stop button work
    }
    const file = await sink.finish();
    if (file) (hooks.onFile || deliver)(`${job.name}.mp4`, file);
    job.status = 'done';
    job.note = ` in ${((performance.now() - started) / 1000).toFixed(1)} s`;
  } catch (err) {
    job.status = 'failed'; job.note = `: ${err.message}`;
    try { await sink.cancel(); } catch { /* already closed */ }
  } finally {
    setOverlays(true);
    if (transparent) { renderer.setClearColor(0x000000, 1); applyScene(); }
    scheduleAutosave();
  }
}

// ---- depth pass: near is white, `range` metres away and beyond is black; cut-out textures keep their shape
const depthMats = new Map();
let depthSaved = null;
function depthMaterialFor(m) {
  if (!depthMats.has(m)) {
    const d = new THREE.MeshBasicMaterial({ color: 0xffffff, map: m.map || null, alphaTest: m.alphaTest, transparent: m.transparent, side: m.side, toneMapped: false });
    d.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = vec3( 1.0 );'); };
    depthMats.set(m, d);
  }
  return depthMats.get(m);
}
function setDepthLook(on, range) {
  if (on) {
    const swapped = [];
    scene.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material)) { swapped.push([o, o.material]); o.material = depthMaterialFor(o.material); } });
    depthSaved = { swapped, background: scene.background, fog: scene.fog };
    weather.group.visible = false;
    depthSaved.dome = skyDome.visible; skyDome.visible = false;
    scene.background = BLACK;
    scene.fog = new THREE.Fog(0x000000, 0, range);
  } else if (depthSaved) {
    for (const [o, m] of depthSaved.swapped) o.material = m;
    scene.background = depthSaved.background;
    scene.fog = depthSaved.fog;
    weather.group.visible = true;
    skyDome.visible = depthSaved.dome;
    depthSaved = null;
  }
}
const BLACK = new THREE.Color(0x000000);

/** Render every waiting job in order. `hooks` lets a caller supply where files go (used by automated checks). */
async function runQueue(hooks = {}) {
  if (rendering) return;
  const waiting = jobs.filter((j) => j.status === 'waiting');
  if (!waiting.length) return;
  if (!hooks.writeFile && waiting.some((j) => j.format === 'png')) {
    if (!window.showDirectoryPicker) { setStatus('This browser cannot write image sequences to a folder. Use MP4, or Chrome or Edge.'); return; }
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { setStatus('No folder chosen, so nothing was rendered'); return; }
    hooks.writeFile = async (name, blob) => {
      const handle = await dir.getFileHandle(name, { create: true });
      const stream = await handle.createWritable();
      await stream.write(blob);
      await stream.close();
    };
  }
  const savedTime = state.time;
  rendering = true; queueStop = false; playing = false;
  syncPlayButton();
  syncQueueUI();
  try {
    for (const job of waiting) {
      if (queueStop) break;
      setStatus(`Rendering ${job.name}…`);
      await runJob(job, hooks);
      syncQueueUI();
    }
  } finally {
    rendering = false;
    resize();
    setTime(savedTime);
    syncQueueUI();
    setStatus(queueStop ? 'Rendering stopped' : 'Render queue finished');
  }
}

$('btn-q-add').addEventListener('click', () => addJob());
$('btn-q-start').addEventListener('click', () => runQueue());
$('btn-q-stop').addEventListener('click', () => { queueStop = true; });

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
    look: state.look,
    depth_of_field: { blur: state.dof.blur, focus_on_bone: state.dof.bone || null, sharp_at_metres: +focusDistance().toFixed(3), focus_keys: state.dof.keys },
    scene: { time_of_day: state.scene.tod, sun_heading: state.scene.azimuth, exposure: state.scene.exposure, fog: state.scene.fog },
    actor: {
      name: actors[1].name,
      position: actorRoot.position.toArray().map(round3),
      heading_deg: round3(THREE.MathUtils.radToDeg(actorRoot.rotation.y)),
      has_skeleton: boneCount > 0, bone_count: boneCount, posed_bones: Object.keys(state.pose).length,
      pose_key_times: state.poseKeys.map((k) => k.t), pose_changed_but_not_keyed: poseDirty,
      bounds: { min: box.min.toArray().map(round3), max: box.max.toArray().map(round3) },
    },
    animation: { ...state.anim, loaded: !!activeClip(), imported_count: clipLibrary.size, then: state.next.name, switch_at: state.next.at, blend: state.next.blend },
    props: props.map((p) => ({ name: p.name, attached_to: p.bone, parts: [...p.parts.keys()].map((k) => ({ part: k, shown: !p.hidden.has(k) })) })),
    markers: state.markers,
  };
}

const toolHandlers = {
  get_scene: () => JSON.stringify(sceneSummary()),
  set_time: (i) => { setTime(numIn(i.seconds, 'seconds')); return `Playhead at ${state.time}s`; },
  set_timeline: (i) => {
    if (i.duration !== undefined) state.duration = numIn(i.duration, 'duration', 1, 600);
    if (i.fps !== undefined) { if (![24, 30, 60, 120, 240].includes(i.fps)) throw new Error('fps must be 24, 30, 60, 120 or 240'); state.fps = i.fps; }
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
    if (i.weather !== undefined) { if (!(i.weather in WEATHER)) throw new Error(`weather must be one of ${Object.keys(WEATHER).join(', ')}`); s.weather = i.weather; }
    applyScene();
    return JSON.stringify({ time_of_day: s.tod, sun_heading: s.azimuth, exposure: s.exposure, fog: s.fog, weather: s.weather || 'clear' });
  },
  set_look: (i) => {
    const change = {};
    if (i.preset !== undefined) change.preset = i.preset;
    for (const [key, lo, hi] of [['bloom', 0, 2], ['ao', 0, 1], ['saturation', 0, 2], ['contrast', 0.5, 2], ['crush', 0, 0.3], ['vignette', 0, 1], ['grain', 0, 0.3], ['rim', 0, 6], ['fill', 0, 6]]) if (i[key] !== undefined) change[key] = numIn(i[key], key, lo, hi);
    if (i.keep_reds !== undefined) change.keepRed = !!i.keep_reds;
    if (i.wet_ground !== undefined) change.wet = !!i.wet_ground;
    if (i.tint !== undefined) change.tint = vec3In(i.tint, 'tint');
    setLook(change);
    return JSON.stringify(state.look);
  },
  set_focus: (i) => {
    const d = state.dof;
    if (i.blur !== undefined) d.blur = numIn(i.blur, 'blur', 0, 10);
    if (i.clear_keys) d.keys = [];
    if (i.bone !== undefined) { if (i.bone && !bones[i.bone]) throw new Error(`No bone named "${i.bone}". Call list_bones.`); d.bone = i.bone || ''; }
    if (i.distance !== undefined) { d.bone = ''; d.distance = numIn(i.distance, 'distance', 0.05, 1000); if (d.keys.length && !i.key) keyFocus(d.distance); }
    if (i.key) { applyTrack(); keyFocus(i.distance !== undefined ? d.distance : focusDistance()); }
    applyTrack();
    syncFocusUI(); syncInspector(); scheduleAutosave();
    return JSON.stringify({ blur: d.blur, focus_on_bone: d.bone || null, sharp_at_metres: +focusDistance().toFixed(3), focus_keys: d.keys });
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
    if (i.smoothing !== undefined) next.lag = numIn(i.smoothing, 'smoothing', 0, 1);
    setMount(next);
    return JSON.stringify({ bone: state.mount.bone, look_at_bone: state.mount.lookAt, keep_level: state.mount.level, smoothing: state.mount.lag || 0 });
  },
  list_animations: () => JSON.stringify([...clipLibrary.values()].map((c) => ({ name: c.name, seconds: round3(c.duration), made_to_loop: c.loop, travels_metres_per_pass: round3(c.travelPerPass * 0.0254), usable: !c.unnamed }))),
  set_animation: (i) => {
    if (i.name && !clipLibrary.has(i.name)) throw new Error(`No imported animation named "${i.name}". Call list_animations to see what is loaded.`);
    const next = {};
    if (i.name !== undefined) { next.name = i.name || null; if (i.name && i.loop === undefined) next.loop = clipLibrary.get(i.name).loop; }
    if (i.start !== undefined) next.start = numIn(i.start, 'start', 0, state.duration);
    if (i.speed !== undefined) next.speed = numIn(i.speed, 'speed', 0.05, 4);
    if (i.loop !== undefined) next.loop = !!i.loop;
    if (i.travel !== undefined) next.travel = !!i.travel;
    if (i.keep_above_ground !== undefined) next.ground = !!i.keep_above_ground;
    setAnimation(next);
    if (i.then !== undefined || i.switch_at !== undefined || i.blend !== undefined) {
      if (i.then && !clipLibrary.has(i.then)) throw new Error(`No imported animation named "${i.then}". Call list_animations to see what is loaded.`);
      const follow = {};
      if (i.then !== undefined) { follow.name = i.then || null; if (i.then) follow.loop = clipLibrary.get(i.then).loop; }
      if (i.switch_at !== undefined) follow.at = numIn(i.switch_at, 'switch_at', 0, state.duration);
      if (i.blend !== undefined) follow.blend = numIn(i.blend, 'blend', 0, 2);
      setNext(follow);
    }
    if (i.more !== undefined) {
      if (!Array.isArray(i.more)) throw new Error('more must be a list');
      for (const m of i.more) if (!clipLibrary.has(m.name)) throw new Error(`No imported animation named "${m.name}". Call list_animations to see what is loaded.`);
      setChain(i.more.map((m) => ({ name: m.name, at: numIn(m.switch_at, 'switch_at', 0, state.duration), blend: m.blend })));
    }
    return JSON.stringify({ ...state.anim, then: state.next.name, switch_at: state.next.at, blend: state.next.blend, more: state.chain.map((c) => ({ name: c.name, switch_at: c.at, blend: c.blend })) });
  },
  set_prop: (i) => {
    const prop = props.find((p) => p.name === i.name);
    if (!prop) throw new Error(`No prop named "${i.name}" is loaded. Loaded props: ${props.map((p) => p.name).join(', ') || 'none'}`);
    if (i.bone !== undefined) {
      if (i.bone && !bones[i.bone]) throw new Error(`No bone named "${i.bone}"`);
      placeProp(prop, i.bone || null);
    }
    for (const [list, hide] of [[i.show, false], [i.hide, true]]) {
      for (const part of list ?? []) {
        if (!prop.parts.has(part)) throw new Error(`"${prop.name}" has no part "${part}"`);
        if (hide) prop.hidden.add(part); else prop.hidden.delete(part);
      }
    }
    applyPropParts(prop);
    storeProps();
    syncPropsUI();
    return JSON.stringify({ name: prop.name, attached_to: prop.bone, hidden: [...prop.hidden] });
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
    applyActor();
    actorRoot.updateMatrixWorld(true);
    return JSON.stringify(names.map((n) => {
      const b = bones[n];
      return { name: n, parent: b.parent?.isBone ? b.parent.name : null, position: b.getWorldPosition(_pa).toArray().map(round3) };
    }));
  },
  pose_bones: (i) => {
    if (!Object.keys(bones).length) throw new Error('The actor has no skeleton. Import a rigged model to pose it.');
    if (!Array.isArray(i.operations) || !i.operations.length) throw new Error('operations must be a non-empty list');
    applyActor();
    i.operations.forEach((op, n) => { try { poseBone(op); } catch (err) { throw new Error(`Operation ${n + 1} (${op?.bone}): ${err.message}. Earlier operations were applied.`); } });
    if (state.autoKey) keyPose();
    syncPoseUI();
    return `Applied ${i.operations.length} operation(s)` + (state.poseKeys.length && poseDirty ? '. This pose is not keyed yet: call key_pose to keep it at this time.' : '');
  },
  reset_pose: (i) => {
    clearPose(i.bones);
    applyPose();
    return `${Object.keys(state.pose).length} bone(s) still posed`;
  },
  key_pose: (i) => {
    keyPose(i.time !== undefined ? numIn(i.time, 'time', 0, state.duration) : state.time);
    return `Pose keys at ${state.poseKeys.map((k) => `${k.t}s`).join(', ')}`;
  },
  delete_pose_keys: (i) => {
    const before = state.poseKeys.length;
    state.poseKeys = i.times === undefined ? [] : state.poseKeys.filter((k) => !i.times.some((t) => Math.abs(k.t - snap(t)) < 1e-4));
    rebuildPoseKeys(); syncPoseUI(); scheduleAutosave();
    return `Removed ${before - state.poseKeys.length} pose key(s); ${state.poseKeys.length} left`;
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
  set_scene: 'Adjusting sky and light', list_animations: 'Checking the animations', set_prop: 'Adjusting a prop', set_animation: 'Setting the animation', mount_camera: 'Mounting the camera', move_actor: 'Moving the actor', add_markers: 'Adding markers',
  list_bones: 'Reading the skeleton', pose_bones: 'Posing bones', key_pose: 'Keying the pose', set_focus: 'Setting the focus', set_look: 'Setting the look', delete_pose_keys: 'Deleting pose keys', reset_pose: 'Resetting the pose', capture_view: 'Looking at the result',
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
  if (rendering) { requestAnimationFrame(tick); return; }      // the render queue is using the renderer
  if (playing) {
    let t = state.time + dt;
    if (t >= state.duration) { if (state.loop) t = 0; else { t = state.duration; playing = false; syncPlayButton(); } }
    state.time = t;                       // not snapped while playing, so motion stays smooth
    camDirty = false;
    poseDirty = false;
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
syncAnimUI();
syncPropsUI();
syncPoseUI();
syncQueueUI();
flushAutosave();                                      // the starting point for undo
$('q-to').value = state.duration;
$('q-fps').value = state.fps;
setMode('free');
keysChanged();
resize();
syncPlayButton();
tick();

// Handle for automated checks and for poking at things from the console.
window.app = {
  state, get track() { return track; }, get bones() { return bones; }, shotCam, freeCam, actorRoot,
  setTime, setMode, setKeyNow, setMount, applyMountPreset, selectActor, renderStill, serialise, load, importFiles, importProp, get props() { return props; }, importAnimations, setAnimation, setNext, setChain, keyPose, setPoseBone, importSky, importMap, placeActorAtView, mapRoot, stepHistory, flushAutosave, keyFocus, focusDistance, gizmo, get poseKeys() { return state.poseKeys; }, execTool, addJob, runQueue, get jobs() { return jobs; },
  assistant: { send: aiSend, messages: aiMessages, useClient(c) { aiClientOverride = c; } },
};
