import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Clip } from '../src/anim.js';

const q = (deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(deg)).toArray();
const make = (over = {}) => new Clip({
  format: 'cinematic-anim-1', name: 'test', frames: 30, framerate: 30, loop: true, has_root_motion: false,
  bones: [
    { name: 'spin', rot: { t: [0, 10, 30], q: [q(0), q(90), q(0)] }, pos: { t: [0, 30], v: [[0, 0, 0], [30, 0, 0]] } },
    { name: 'fixed', rot: { t: [0], q: [q(45)] } },
    { name: 'still' },
  ],
  ...over,
});
const angle = (quat) => THREE.MathUtils.radToDeg(2 * Math.atan2(quat.z, quat.w));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('rejects files that are not animation exports', () => {
  assert.throws(() => new Clip({ format: 'something-else' }));
  assert.throws(() => new Clip(null));
});

test('duration comes from the last frame index', () => {
  close(make().duration, 1);
  close(make({ frames: 46 }).duration, 46 / 30);
});

test('rotation hits keys exactly and interpolates between them', () => {
  const c = make(), out = new THREE.Quaternion();
  for (const [frame, want] of [[0, 0], [10, 90], [30, 0], [5, 45], [20, 45]]) {
    assert.equal(Clip.rotation(c.bones[0], frame, out), true);
    close(angle(out), want, 1e-4);
  }
});

test('a single-key track holds its value', () => {
  const c = make(), out = new THREE.Quaternion();
  for (const frame of [0, 7.5, 30]) { Clip.rotation(c.bones[1], frame, out); close(angle(out), 45, 1e-4); }
});

test('tracks without rotation or position report that', () => {
  const c = make();
  assert.equal(Clip.rotation(c.bones[2], 3, new THREE.Quaternion()), false);
  assert.equal(Clip.position(c.bones[1], 3, new THREE.Vector3()), false);
});

test('position interpolates linearly', () => {
  const c = make(), out = new THREE.Vector3();
  Clip.position(c.bones[0], 15, out); close(out.x, 15);
  Clip.position(c.bones[0], 30, out); close(out.x, 30);
});

test('looping wraps time, non-looping clamps', () => {
  const c = make();
  close(c.frameAt(0.5), 15);
  close(c.frameAt(1.5), 15);          // second time round
  close(c.frameAt(-0.5), 15);         // before the start also wraps
  close(c.frameAt(1.5, false), 30);   // one-shot holds the last frame
  close(c.frameAt(-1, false), 0);
});

test('flags animations whose bone names were never resolved', () => {
  assert.equal(make().unnamed, false);
  assert.equal(make({ bones: [{ name: 'bone_0' }, { name: 'bone_1' }] }).unnamed, true);
});

test('root motion: travels within a pass and keeps going across loops', () => {
  const c = make({ root: { pos: { t: [0, 30], v: [[0, 0, 0], [100, 0, 0]] } } });
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  close(c.travelPerPass, 100);
  c.rootAt(0.5, true, p, q); close(p.x, 50);
  c.rootAt(1.0, true, p, q); close(p.x, 100);
  c.rootAt(2.5, true, p, q); close(p.x, 250);            // two full passes and a half
  c.rootAt(2.5, false, p, q); close(p.x, 100);           // a one-shot stops where it ends
  c.rootAt(-1, true, p, q); close(p.x, 0);
});

test('root motion: no jump at the loop point', () => {
  const c = make({ root: { pos: { t: [0, 30], v: [[0, 0, 0], [100, 0, 0]] } } });
  const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Quaternion();
  c.rootAt(0.9999, true, a, q); c.rootAt(1.0001, true, b, q);
  assert.ok(Math.abs(a.x - b.x) < 0.1);
});

test('root motion: a turn carries into the next pass', () => {
  const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2).toArray();
  const c = make({ root: { pos: { t: [0, 30], v: [[0, 0, 0], [10, 0, 0]] }, rot: { t: [0, 30], q: [[0, 0, 0, 1], quarter] } } });
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  c.rootAt(2, true, p, q);                               // forward 10, turn left, forward 10 again
  close(p.x, 10, 1e-4); close(p.y, 10, 1e-4);
});

test('clips without root motion stay put', () => {
  const p = new THREE.Vector3(1, 1, 1), q = new THREE.Quaternion();
  make().rootAt(3, true, p, q);
  assert.deepEqual(p.toArray(), [0, 0, 0]);
  close(make().travelPerPass, 0);
});
