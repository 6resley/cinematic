import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { toLocal, toWorld, reframeKeys, bodyAxes } from '../src/mount.js';

const pose = (x, y, z, rx = 0, ry = 0, rz = 0) => ({
  position: new THREE.Vector3(x, y, z),
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
});
const near = (a, b, eps = 1e-9) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} != ${b}`));
const sameRotation = (a, b) => assert.ok(Math.abs(Math.abs(a.dot(b)) - 1) < 1e-9);

test('world -> local -> world returns the same pose', () => {
  const frame = pose(1, 2, 3, 0.4, -1.1, 0.7), world = pose(-2, 0.5, 4, 1.0, 0.2, -0.3);
  const back = toWorld(frame, toLocal(frame, world, pose(0, 0, 0)), pose(0, 0, 0));
  near(back.position.toArray(), world.position.toArray());
  sameRotation(back.quaternion, world.quaternion);
});

test('an identity frame leaves poses unchanged', () => {
  const world = pose(3, 1, -2, 0.3, 0.6, 0.1);
  const local = toLocal(pose(0, 0, 0), world, pose(0, 0, 0));
  near(local.position.toArray(), [3, 1, -2]);
  sameRotation(local.quaternion, world.quaternion);
});

test('a mounted camera follows the mount when it moves and turns', () => {
  // camera 1 m in front of a mount at the origin, then the mount moves to x=5 and turns a quarter turn
  const local = toLocal(pose(0, 0, 0), pose(0, 0, -1), pose(0, 0, 0));
  const world = toWorld(pose(5, 0, 0, 0, Math.PI / 2, 0), local, pose(0, 0, 0));
  near(world.position.toArray(), [4, 0, 0], 1e-9);
});

test('conversion works in place', () => {
  const frame = pose(1, 1, 1, 0.2, 0.3, 0.4), p = pose(2, 3, 4, 0.5, 0.1, 0.9);
  const want = toLocal(frame, p, pose(0, 0, 0));
  toLocal(frame, p, p);
  near(p.position.toArray(), want.position.toArray());
  sameRotation(p.quaternion, want.quaternion);
});

test('reframing keys keeps them in the same place in the world', () => {
  const oldFrame = pose(0, 0, 0), newFrame = pose(2, 1, -3, 0.3, 1.2, -0.4);
  const original = pose(1, 2, 3, 0.1, 0.2, 0.3);
  const keys = [{ t: 0, pos: original.position.toArray(), quat: original.quaternion.toArray(), fov: 40, ease: 'auto' }];
  reframeKeys(keys, oldFrame, newFrame);
  const k = { position: new THREE.Vector3().fromArray(keys[0].pos), quaternion: new THREE.Quaternion().fromArray(keys[0].quat) };
  const world = toWorld(newFrame, k, pose(0, 0, 0));
  near(world.position.toArray(), original.position.toArray());
  sameRotation(world.quaternion, original.quaternion);
  assert.equal(keys[0].fov, 40);
  assert.equal(keys[0].ease, 'auto');
});

test('body axes: facing +X when the right shoulder is toward +Z', () => {
  const ax = bodyAxes(new THREE.Vector3(0, 1.4, -0.2), new THREE.Vector3(0, 1.5, 0.2));
  near(ax.right.toArray(), [0, 0, 1]);
  near(ax.forward.toArray(), [1, 0, 0]);
  near(ax.up.toArray(), [0, 1, 0]);
});
