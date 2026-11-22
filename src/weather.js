// Rain, snow and dust. Every particle's place is worked out from the timeline time alone, so scrubbing, motion-blur
// sub-frames and renders at any frame rate all agree. Particles live in a box that follows whichever camera is drawing.
import * as THREE from 'three';

export const WEATHER = {
  clear: null,
  rain: { label: 'Rain', lines: true, count: 5000, velocity: [-1.5, -11, 0.5], length: 0.32, color: 0xcfd8e3, opacity: 0.32 },
  storm: { label: 'Heavy rain', lines: true, count: 12000, velocity: [-4.5, -14, -1], length: 0.5, color: 0xcfd8e3, opacity: 0.4 },
  snow: { label: 'Snow', lines: false, count: 6000, velocity: [-0.5, -1.3, 0.2], size: 0.035, sway: 0.18, color: 0xffffff, opacity: 0.85 },
  dust: { label: 'Dust', lines: false, count: 5000, velocity: [0.6, 0.03, 0.25], size: 0.028, sway: 0.3, color: 0xe6d3ab, opacity: 0.55 },
};
const BOX = new THREE.Vector3(26, 14, 26);

const COMMON = /* glsl */`
  uniform float uTime; uniform vec3 uCam; uniform vec3 uVel; uniform vec3 uBox; uniform float uSway;
  vec3 place(vec3 seed) {
    vec3 p = seed * uBox + uVel * uTime;
    p.x += sin(uTime * 1.3 + seed.y * 40.0) * uSway;
    p.z += cos(uTime * 1.1 + seed.x * 40.0) * uSway;
    return mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  }`;

function build(kind) {
  const spec = WEATHER[kind];
  const per = spec.lines ? 2 : 1, seeds = new Float32Array(spec.count * per * 3), ends = new Float32Array(spec.count * per);
  let s = 12345;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };      // fixed sequence: the same weather every time
  for (let i = 0; i < spec.count; i++) {
    const x = rand(), y = rand(), z = rand();
    for (let k = 0; k < per; k++) { seeds.set([x, y, z], (i * per + k) * 3); ends[i * per + k] = k; }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('end', new THREE.BufferAttribute(ends, 1));
  const uniforms = {
    uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3().fromArray(spec.velocity) }, uBox: { value: BOX },
    uSway: { value: spec.sway || 0 }, uLen: { value: spec.length || 0 }, uSize: { value: spec.size || 0 }, uScale: { value: 600 },
    uColor: { value: new THREE.Color(spec.color) }, uOpacity: { value: spec.opacity },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: spec.lines
      ? `${COMMON} uniform float uLen; attribute float end; varying float vFade;
         void main() { vec3 p = place(position) - normalize(uVel) * uLen * end; vFade = 1.0 - end * 0.85; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`
      : `${COMMON} uniform float uSize; uniform float uScale; varying float vFade;
         void main() { vec4 mv = viewMatrix * vec4(place(position), 1.0); vFade = 1.0; gl_PointSize = uSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vFade;
      void main() { float a = uOpacity * vFade; ${spec.lines ? '' : 'a *= smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5));'} gl_FragColor = vec4(uColor, a); }`,
  });
  const object = spec.lines ? new THREE.LineSegments(geometry, material) : new THREE.Points(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 10;
  return { object, uniforms };
}

/** `getTime` returns the timeline time in seconds. Add `.group` to the scene and call set(kind) to change the weather. */
export function createWeather(getTime) {
  const group = new THREE.Group(), size = new THREE.Vector2();
  let current = 'clear';
  return {
    group,
    get kind() { return current; },
    set(kind) {
      if (!(kind in WEATHER)) kind = 'clear';
      if (kind === current) return;
      for (const child of [...group.children]) { group.remove(child); child.geometry.dispose(); child.material.dispose(); }
      current = kind;
      if (!WEATHER[kind]) return;
      const made = build(kind);
      made.object.onBeforeRender = (renderer, scene, camera) => {
        made.uniforms.uTime.value = getTime();
        made.uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
        made.uniforms.uScale.value = renderer.getDrawingBufferSize(size).y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 50) / 2));   // so flakes are the same size at any resolution
      };
      group.add(made.object);
    },
  };
}
