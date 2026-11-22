import test from 'node:test';
import assert from 'node:assert/strict';
import { twoBoneReach } from '../src/ik.js';

// turn point p about an axis through `pivot` (Rodrigues' formula)
function turn(p, pivot, axis, angle) {
  const v = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]], c = Math.cos(angle), s = Math.sin(angle);
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const x = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return v.map((vi, i) => pivot[i] + vi * c + x[i] * s + axis[i] * d * (1 - c));
}
// apply the three turns the way the app does and return where the joints end up
function solve(a, b, c, t) {
  const r = twoBoneReach(a, b, c, t);
  let b1 = turn(b, a, r.bendAxis, r.upperBend), c1 = turn(c, a, r.bendAxis, r.upperBend);
  c1 = turn(c1, b1, r.bendAxis, r.midBend);
  return { b: turn(b1, a, r.swingAxis, r.swing), c: turn(c1, a, r.swingAxis, r.swing) };
}
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

test('the end of a bent limb reaches the target and bone lengths are kept', () => {
  const a = [0, 1, 0], b = [0.3, 0.8, 0.05], c = [0.55, 0.95, 0];
  for (const t of [[0.5, 1.1, 0.1], [0.3, 0.6, -0.2], [0.55, 1.01, 0], [0.2, 1.3, 0.3]]) {
    const out = solve(a, b, c, t);
    assert.ok(dist(out.c, t) < 1e-6, `missed ${t}`);
    assert.ok(Math.abs(dist(a, out.b) - dist(a, b)) < 1e-9);
    assert.ok(Math.abs(dist(out.b, out.c) - dist(b, c)) < 1e-9);
  }
});

test('a target already at the end changes nothing', () => {
  const a = [0, 1, 0], b = [0.3, 0.8, 0], c = [0.6, 1, 0];
  const r = twoBoneReach(a, b, c, c);
  assert.ok(Math.abs(r.upperBend) < 1e-6 && Math.abs(r.midBend) < 1e-6 && Math.abs(r.swing) < 1e-6);
});

test('a straight limb can still be pulled in', () => {
  const a = [0, 1, 0], b = [0.3, 1, 0], c = [0.6, 1, 0], t = [0.5, 1.05, 0];
  assert.ok(dist(solve(a, b, c, t).c, t) < 1e-6);
});

test('a target out of reach stretches the limb towards it', () => {
  const a = [0, 1, 0], b = [0.3, 0.8, 0], c = [0.6, 1, 0];
  const out = solve(a, b, c, [5, 1, 0]);
  assert.ok(out.c[0] > 0.7 && Math.abs(out.c[1] - 1) < 0.01);
});
