import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraTrack } from '../src/keys.js';

const cam = (x, y, z, fov = 40, yaw = 0) => {
  const c = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
  c.position.set(x, y, z);
  c.rotation.set(0, yaw, 0);
  c.updateMatrixWorld();
  return c;
};
const out = () => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 0 });
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('empty track reports nothing', () => {
  assert.equal(new CameraTrack().evaluate(1, out()), false);
});

test('single key holds everywhere', () => {
  const t = new CameraTrack();
  t.setKey(2, cam(1, 2, 3, 55));
  for (const time of [0, 2, 9]) {
    const o = out();
    assert.equal(t.evaluate(time, o), true);
    assert.deepEqual(o.position.toArray(), [1, 2, 3]);
    close(o.fov, 55);
  }
});

test('poses are exact at every key time', () => {
  const t = new CameraTrack();
  t.setKey(0, cam(0, 1, 5, 30));
  t.setKey(2, cam(4, 2, 5, 50, 0.6));
  t.setKey(5, cam(8, 1, -2, 70, 1.2));
  t.setKey(6, cam(8, 3, -6, 40, 1.5));
  for (const k of t.keys) {
    const o = out();
    t.evaluate(k.t, o);
    o.position.toArray().forEach((v, i) => close(v, k.pos[i]));
    close(o.fov, k.fov);
    close(Math.abs(o.quaternion.dot(new THREE.Quaternion().fromArray(k.quat))), 1);
  }
});

test('keys stay sorted and replacing a key keeps its ease', () => {
  const t = new CameraTrack();
  t.setKey(3, cam(3, 0, 0));
  t.setKey(1, cam(1, 0, 0)).ease = 'linear';
  t.setKey(2, cam(2, 0, 0));
  assert.deepEqual(t.keys.map((k) => k.t), [1, 2, 3]);
  t.setKey(1, cam(9, 0, 0));
  assert.equal(t.keys.length, 3);
  assert.equal(t.keys[0].ease, 'linear');
  assert.equal(t.keys[0].pos[0], 9);
});

test('two-key auto move starts and ends at rest and passes the midpoint halfway', () => {
  const t = new CameraTrack();
  t.setKey(0, cam(0, 0, 0, 30));
  t.setKey(4, cam(10, 0, 0, 50));
  const o = out();
  t.evaluate(2, o); close(o.position.x, 5); close(o.fov, 40);
  t.evaluate(0.04, o); assert.ok(o.position.x < 0.01, 'slow start');
  t.evaluate(3.96, o); assert.ok(o.position.x > 9.99, 'slow stop');
});

test('motion is monotonic along a straight multi-key path', () => {
  const t = new CameraTrack();
  [0, 1, 2, 3, 4].forEach((s) => t.setKey(s, cam(s * 2, 0, 0)));
  const o = out();
  let prev = -1;
  for (let s = 0; s <= 400; s++) {
    t.evaluate(s / 100, o);
    assert.ok(o.position.x >= prev - 1e-9, `went backwards at ${s / 100}`);
    prev = o.position.x;
  }
});

test('hold keeps the pose until the next key', () => {
  const t = new CameraTrack();
  t.setKey(0, cam(0, 0, 0)).ease = 'hold';
  t.setKey(1, cam(5, 0, 0));
  const o = out();
  t.evaluate(0.99, o); close(o.position.x, 0);
  t.evaluate(1, o); close(o.position.x, 5);
});

test('retime refuses to collide and removeKey works', () => {
  const t = new CameraTrack();
  const a = t.setKey(0, cam(0, 0, 0));
  const b = t.setKey(1, cam(1, 0, 0));
  assert.equal(t.retime(b, 0), false);
  assert.equal(t.retime(b, 3), true);
  assert.deepEqual(t.keys.map((k) => k.t), [0, 3]);
  assert.equal(t.removeKey(a), true);
  assert.equal(t.keys.length, 1);
});

test('round-trips through JSON', () => {
  const t = new CameraTrack();
  t.setKey(0, cam(0, 1, 2, 33));
  t.setKey(2, cam(3, 4, 5, 44, 0.4));
  const copy = new CameraTrack(JSON.parse(JSON.stringify(t.toJSON())));
  const a = out(), b = out();
  t.evaluate(1.3, a); copy.evaluate(1.3, b);
  assert.deepEqual(a.position.toArray(), b.position.toArray());
  close(a.fov, b.fov);
});
