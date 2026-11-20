// Camera keyframe track: pure data + interpolation, no DOM.
import * as THREE from 'three';

const EPS = 1e-4;

// Ease shapes for one segment, u in 0..1.
// easeIn/easeOut leave the far end at speed 1 so they join a linear neighbour without a jolt.
const easeIn = (u) => u * u * (2 - u);
const easeOut = (u) => 1 - easeIn(1 - u);
const smooth = (u) => u * u * (3 - 2 * u);

export const EASE_MODES = ['auto', 'linear', 'smooth', 'hold'];

function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * u
      + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u2
      + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u3);
  }
  return out;
}

export class CameraTrack {
  constructor(keys = []) {
    this.keys = keys.map((k) => ({ t: k.t, pos: [...k.pos], quat: [...k.quat], fov: k.fov, ease: k.ease ?? 'auto' }));
    this.sort();
  }

  sort() { this.keys.sort((a, b) => a.t - b.t); }

  get start() { return this.keys.length ? this.keys[0].t : 0; }
  get end() { return this.keys.length ? this.keys[this.keys.length - 1].t : 0; }

  keyAt(t) { return this.keys.find((k) => Math.abs(k.t - t) < EPS) || null; }

  /** Add or replace the key at time t from a camera's current pose. Returns the key. */
  setKey(t, cam) {
    const existing = this.keyAt(t);
    const key = {
      t,
      pos: cam.position.toArray(),
      quat: cam.quaternion.toArray(),
      fov: cam.fov,
      ease: existing ? existing.ease : 'auto',
    };
    if (existing) Object.assign(existing, key);
    else { this.keys.push(key); this.sort(); }
    return existing || key;
  }

  removeKey(key) {
    const i = this.keys.indexOf(key);
    if (i >= 0) this.keys.splice(i, 1);
    return i >= 0;
  }

  /** Move a key in time; refuses to land on another key. Returns true if moved. */
  retime(key, t) {
    const clash = this.keyAt(t);
    if (clash && clash !== key) return false;
    key.t = t;
    this.sort();
    return true;
  }

  segmentEase(i, u) {
    const mode = this.keys[i].ease;
    const last = this.keys.length - 2;
    if (mode === 'hold') return 0;
    if (mode === 'linear') return u;
    if (mode === 'smooth') return smooth(u);
    // auto: ease out of the first key and into the last, flow through the ones between
    if (i === 0 && i === last) return smooth(u);
    if (i === 0) return easeIn(u);
    if (i === last) return easeOut(u);
    return u;
  }

  /**
   * Write the pose at time t into `out` ({ position: Vector3, quaternion: Quaternion, fov }).
   * Returns false when the track has no keys.
   */
  evaluate(t, out) {
    const keys = this.keys, n = keys.length;
    if (!n) return false;
    const copy = (k) => {
      out.position.fromArray(k.pos);
      out.quaternion.fromArray(k.quat);
      out.fov = k.fov;
      return true;
    };
    if (n === 1 || t <= keys[0].t) return copy(keys[0]);
    if (t >= keys[n - 1].t) return copy(keys[n - 1]);
    let i = 0;
    while (i < n - 2 && keys[i + 1].t <= t) i++;
    const a = keys[i], b = keys[i + 1];
    const u = this.segmentEase(i, (t - a.t) / (b.t - a.t));
    const before = keys[i - 1] || a, after = keys[i + 2] || b;
    out.position.fromArray(catmullRom(before.pos, a.pos, b.pos, after.pos, u));
    _qa.fromArray(a.quat); _qb.fromArray(b.quat);
    out.quaternion.slerpQuaternions(_qa, _qb, u);
    out.fov = a.fov + (b.fov - a.fov) * u;
    return true;
  }

  /** Sample the path as points for drawing. */
  samplePath(stepsPerSegment = 24) {
    const pts = [];
    if (this.keys.length < 2) return pts;
    const out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 0 };
    const total = (this.keys.length - 1) * stepsPerSegment;
    for (let s = 0; s <= total; s++) {
      this.evaluate(this.start + (this.end - this.start) * (s / total), out);
      pts.push(out.position.clone());
    }
    return pts;
  }

  toJSON() { return this.keys.map((k) => ({ ...k })); }
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
