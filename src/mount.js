// Camera mounts: maths for a camera that rides on a bone or prop.
// A "frame" is where the mount is (position + rotation, no scale). A camera pose can be expressed
// in the world or relative to a frame; these helpers convert between the two.
import * as THREE from 'three';

const _q = new THREE.Quaternion();
const _world = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

/** World pose -> pose relative to `frame`. `out` may be the same object as `world`. */
export function toLocal(frame, world, out) {
  _q.copy(frame.quaternion).invert();
  out.position.copy(world.position).sub(frame.position).applyQuaternion(_q);
  out.quaternion.copy(_q.multiply(world.quaternion));
  return out;
}

/** Pose relative to `frame` -> world pose. `out` may be the same object as `local`. */
export function toWorld(frame, local, out) {
  out.position.copy(local.position).applyQuaternion(frame.quaternion).add(frame.position);
  out.quaternion.copy(_q.copy(frame.quaternion).multiply(local.quaternion));
  return out;
}

/** Rewrite keys authored relative to `oldFrame` so they sit in the same world place relative to `newFrame`. */
export function reframeKeys(keys, oldFrame, newFrame) {
  for (const k of keys) {
    _world.position.fromArray(k.pos);
    _world.quaternion.fromArray(k.quat);
    toWorld(oldFrame, _world, _world);
    toLocal(newFrame, _world, _world);
    k.pos = _world.position.toArray();
    k.quat = _world.quaternion.toArray();
  }
}

/**
 * Which way a character faces, worked out from its two shoulders so it does not depend on
 * how a particular model's bones are oriented. Returns unit vectors { right, up, forward }.
 */
export function bodyAxes(leftShoulder, rightShoulder) {
  const up = new THREE.Vector3(0, 1, 0);
  const right = rightShoulder.clone().sub(leftShoulder).setY(0);
  if (right.lengthSq() < 1e-10) right.set(1, 0, 0);
  right.normalize();
  return { right, up, forward: up.clone().cross(right).normalize() };
}
