// Animation clips exported by the ripper (.anim.json): pure sampling, no DOM.
// Rotations are quaternions relative to the parent bone. Positions are shifts, in the model's own units, that are
// added to the bone's offset in the model (the hips dropping in a run, the head bobbing); they do not replace it.
import * as THREE from 'three';

const _a = new THREE.Quaternion();
const _b = new THREE.Quaternion();

/** Index of the last key at or before `frame`. `times` is sorted and starts at 0. */
function keyBefore(times, frame) {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= frame) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export class Clip {
  constructor(data) {
    if (!data || data.format !== 'cinematic-anim-1') throw new Error('Not an animation file made by the ripper');
    this.name = data.name;
    this.frames = data.frames;                 // index of the last frame; frame 0 and the last frame match in a loop
    this.framerate = data.framerate;
    this.loop = !!data.loop;
    this.hasRootMotion = !!data.has_root_motion;
    this.bones = data.bones;
    this.unnamed = this.bones.length > 0 && this.bones.every((b) => /^bone_\d+$/.test(b.name));
  }

  get duration() { return this.frames > 0 ? this.frames / this.framerate : 0; }

  /** Frame number for a time in seconds, wrapped for loops and clamped otherwise. */
  frameAt(seconds, loop = this.loop) {
    if (this.frames <= 0) return 0;
    let f = seconds * this.framerate;
    if (loop) { f %= this.frames; if (f < 0) f += this.frames; }
    return Math.min(Math.max(f, 0), this.frames);
  }

  /** Rotation of one bone track at `frame`, written into `out`. Returns false if the track has no rotation. */
  static rotation(track, frame, out) {
    const r = track.rot;
    if (!r) return false;
    const i = keyBefore(r.t, frame);
    if (i >= r.t.length - 1 || frame <= r.t[i]) { out.fromArray(r.q[i]); return true; }
    const u = (frame - r.t[i]) / (r.t[i + 1] - r.t[i]);
    out.slerpQuaternions(_a.fromArray(r.q[i]), _b.fromArray(r.q[i + 1]), u);
    return true;
  }

  /** Position of one bone track at `frame`, written into `out`. Returns false if the track has no position. */
  static position(track, frame, out) {
    const p = track.pos;
    if (!p) return false;
    const i = keyBefore(p.t, frame);
    if (i >= p.t.length - 1 || frame <= p.t[i]) { out.fromArray(p.v[i]); return true; }
    const u = (frame - p.t[i]) / (p.t[i + 1] - p.t[i]);
    const a = p.v[i], b = p.v[i + 1];
    out.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    return true;
  }
}
