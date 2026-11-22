// The finished "look" of a shot: soft contact shadowing, glow on bright areas, then a film grade (contrast, colour,
// keep-the-reds, vignette, grain). Runs on the graphics card after the scene is drawn.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const LOOK_OFF = { preset: 'none', bloom: 0, ao: 0, saturation: 1, keepRed: false, contrast: 1, crush: 0, tint: [1, 1, 1], vignette: 0, grain: 0, rim: 0, fill: 0, wet: false };
export const LOOKS = {
  none: { label: 'None (plain)', ...LOOK_OFF },
  noir: { label: 'Noir with red', preset: 'noir', bloom: 0.55, ao: 0.7, saturation: 0.1, keepRed: true, contrast: 1.28, crush: 0.05, tint: [1, 1, 1], vignette: 0.5, grain: 0.05, rim: 3, fill: 1.4, wet: true },
  gritty: { label: 'Gritty night', preset: 'gritty', bloom: 0.3, ao: 0.8, saturation: 0.32, keepRed: false, contrast: 1.38, crush: 0.07, tint: [0.96, 1, 0.9], vignette: 0.65, grain: 0.08, rim: 4, fill: 1.8, wet: true },
  golden: { label: 'Golden hour', preset: 'golden', bloom: 0.4, ao: 0.6, saturation: 1.12, keepRed: false, contrast: 1.14, crush: 0.02, tint: [1.07, 1, 0.9], vignette: 0.32, grain: 0.03, rim: 2.2, fill: 0.9, wet: false },
};

/** True if this look changes the picture after the scene is drawn (so the extra passes are needed). */
export const lookIsActive = (l) => l.bloom > 0 || l.ao > 0 || l.saturation !== 1 || l.contrast !== 1 || l.crush > 0 || l.vignette > 0 || l.grain > 0 || l.tint.some((v) => v !== 1);

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uSat: { value: 1 }, uKeepRed: { value: 0 }, uContrast: { value: 1 }, uCrush: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) }, uVignette: { value: 0 }, uGrain: { value: 0 }, uTime: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uSat, uKeepRed, uContrast, uCrush, uVignette, uGrain, uTime; uniform vec3 uTint; uniform vec2 uSize; varying vec2 vUv;
    float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float red = clamp((c.r - max(c.g, c.b)) * 5.0, 0.0, 1.0);                 // how clearly red this pixel is
      c = mix(vec3(luma), c, mix(uSat, max(uSat, 1.2), red * uKeepRed));
      c *= uTint;
      c = (c - 0.5) * uContrast + 0.5;
      c = max(c - uCrush, 0.0) / (1.0 - uCrush);
      c *= 1.0 - uVignette * smoothstep(0.3, 0.95, length(vUv - 0.5) * 1.25);
      c += (hash(floor(vUv * uSize) + floor(uTime * 240.0) * 17.0) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export function createLook(renderer, scene) {
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(1);
  const stand = new THREE.PerspectiveCamera();      // the passes need a camera to exist; the real one is set on every draw
  const renderPass = new RenderPass(scene, stand);
  const ao = new GTAOPass(scene, stand, 4, 4);
  ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1, scale: 1.1, samples: 16 });
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.4, 0.65, 0.95);
  const grade = new ShaderPass(GradeShader);
  for (const pass of [renderPass, ao, bloom, new OutputPass(), grade]) composer.addPass(pass);
  let width = 0, height = 0;
  const viewport = new THREE.Vector4(), scissor = new THREE.Vector4();
  return {
    /** Draw the scene through `camera` with the look applied, into the renderer's current viewport. */
    render(camera, look, time) {
      renderer.getCurrentViewport(viewport);
      renderer.getScissor(scissor);
      const scissorTest = renderer.getScissorTest(), ratio = renderer.getPixelRatio();
      const w = Math.max(4, Math.round(viewport.z)), h = Math.max(4, Math.round(viewport.w));
      if (w !== width || h !== height) { composer.setSize(w, h); width = w; height = h; }
      renderPass.camera = camera; ao.camera = camera;
      ao.enabled = look.ao > 0; ao.blendIntensity = look.ao;
      bloom.enabled = look.bloom > 0; bloom.strength = look.bloom;
      const u = grade.uniforms;
      u.uSat.value = look.saturation; u.uKeepRed.value = look.keepRed ? 1 : 0; u.uContrast.value = look.contrast; u.uCrush.value = look.crush;
      u.uTint.value.fromArray(look.tint); u.uVignette.value = look.vignette; u.uGrain.value = look.grain; u.uTime.value = time; u.uSize.value.set(w, h);
      composer.render();
      renderer.setRenderTarget(null);                 // hand the renderer back the way it was
      renderer.setViewport(viewport.x / ratio, viewport.y / ratio, viewport.z / ratio, viewport.w / ratio);
      renderer.setScissor(scissor.x / ratio, scissor.y / ratio, scissor.z / ratio, scissor.w / ratio);
      renderer.setScissorTest(scissorTest);
    },
  };
}
