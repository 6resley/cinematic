// Two-bone reach (shoulder-elbow-wrist or hip-knee-ankle): the rotations that bring the end of a limb to a target
// while keeping both bone lengths. Plain arrays, no three.js, so it can be tested on its own.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const acos = (x) => Math.acos(Math.min(1, Math.max(-1, x)));

/**
 * a, b, c are the world positions of the upper joint, middle joint and end; t is where the end should go.
 * Returns three world-space turns to apply in order: the upper bone about `bendAxis` by `upperBend`, the middle
 * bone about `bendAxis` by `midBend`, then the upper bone about `swingAxis` by `swing`. Angles are in radians.
 * A target out of reach is pulled in to the limb's full length.
 */
export function twoBoneReach(a, b, c, t) {
  const ab = sub(b, a), ac = sub(c, a), cb = sub(b, c), at = sub(t, a);
  const lab = len(ab), lcb = len(cb);
  const lat = Math.min(Math.max(len(at), 1e-4), lab + lcb - 1e-4);
  const acDir = unit(ac) || [0, -1, 0];
  const angA0 = acos(dot(acDir, unit(ab) || acDir));
  const angB0 = acos(dot(unit(sub(a, b)) || acDir, unit(sub(c, b)) || acDir));
  const angA1 = acos((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat));
  const angB1 = acos((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb));
  // a straight limb has no bend plane yet: bend it so the middle joint rises
  const bendAxis = unit(cross(ac, ab)) || unit(cross(ac, [0, 1, 0])) || [1, 0, 0];
  const atDir = unit(at) || acDir;
  const swingAxis = unit(cross(acDir, atDir)) || bendAxis;
  return { bendAxis, upperBend: angA1 - angA0, midBend: angB1 - angB0, swingAxis, swing: acos(dot(acDir, atDir)) };
}
