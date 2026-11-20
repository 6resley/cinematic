// Look-through camera controls for Camera mode: drag to look, WASD/QE to fly, wheel to dolly.
import * as THREE from 'three';

const MOVE_KEYS = { KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyQ: [0, -1, 0], KeyE: [0, 1, 0] };
const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);

export class FlyLook {
  constructor(dom, onChange) {
    this.dom = dom;
    this.onChange = onChange;
    this.camera = null;
    this.enabled = false;
    this.speed = 2.5;          // metres per second
    this.held = new Set();
    this.dragging = false;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._v = new THREE.Vector3();

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled || !this.camera) return;
      this.dragging = true;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.enabled) return;
      const eu = this._euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
      eu.y -= e.movementX * 0.0028;
      eu.x = Math.max(-1.55, Math.min(1.55, eu.x - e.movementY * 0.0028));
      this.camera.quaternion.setFromEuler(eu);
      this.onChange();
    });
    const stop = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    };
    dom.addEventListener('pointerup', stop);
    dom.addEventListener('pointercancel', stop);
    dom.addEventListener('wheel', (e) => {
      if (!this.enabled || !this.camera) return;
      e.preventDefault();
      this._v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(this._v, -e.deltaY * 0.0015 * this.speed);
      this.onChange();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (this.enabled && !typing(e) && MOVE_KEYS[e.code] && !e.ctrlKey && !e.metaKey) this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.held.clear(); this.dragging = false; }
  }

  /** Advance held-key movement. Call once per frame with seconds elapsed. */
  update(dt, fast = false) {
    if (!this.enabled || !this.camera || !this.held.size) return;
    this._v.set(0, 0, 0);
    for (const code of this.held) {
      const d = MOVE_KEYS[code];
      this._v.x += d[0]; this._v.y += d[1]; this._v.z += d[2];
    }
    if (this._v.lengthSq() === 0) return;
    const up = this._v.y;
    this._v.y = 0;
    this._v.applyQuaternion(this.camera.quaternion);
    this._v.y += up;                                   // Q/E move straight up and down
    this.camera.position.addScaledVector(this._v.normalize(), this.speed * (fast ? 4 : 1) * dt);
    this.onChange();
  }
}
