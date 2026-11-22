// Render queue helpers: which moments to render, and where finished frames go (an MP4 file or numbered PNGs).
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_VERY_HIGH, canEncodeVideo } from 'mediabunny';

/** The time of every frame in a job. A range always yields at least one frame. */
export function frameTimes(from, to, fps) {
  const count = Math.max(1, Math.round((to - from) * fps));
  return Array.from({ length: count }, (_, i) => from + i / fps);
}

/**
 * Moments to render and average for one frame's motion blur. `shutter` is the fraction of the frame interval the
 * shutter stays open: 0.5 is the classic film look (a 180 degree shutter).
 */
export function subframeTimes(time, fps, samples, shutter = 0.5) {
  const n = Math.max(1, Math.floor(samples));
  return Array.from({ length: n }, (_, k) => time + (k / n) * (shutter / fps));
}

export function frameName(base, index, digits = 5) {
  return `${base}_${String(index + 1).padStart(digits, '0')}.png`;
}

/** File-system-safe version of a job name. */
export function safeName(name) {
  return (String(name).trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'shot').slice(0, 60);
}

/** True if this browser can encode H.264 at the given size. */
export function canMakeMp4(width, height) {
  if (typeof VideoEncoder === 'undefined') return Promise.resolve(false);
  return canEncodeVideo('avc', { width, height }).catch(() => false);
}

/** Collects frames from `canvas` into an H.264 MP4. Call add(i) after drawing each frame, then finish() for the file. */
export async function createMp4Sink(canvas, fps) {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  return {
    add: (index) => source.add(index / fps, 1 / fps),
    cancel: () => output.cancel(),
    async finish() {
      await output.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
  };
}

/** Sends each frame of `canvas` to `write(name, blob)` as a numbered PNG. */
export function createPngSink(canvas, base, write) {
  return {
    async add(index) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      await write(frameName(base, index), blob);
    },
    cancel: async () => {},
    finish: async () => null,
  };
}

/** Points spread evenly over a unit disk (a sunflower pattern): where on the lens each depth-of-field sample looks from. */
export function lensOffsets(n) {
  if (n < 2) return [[0, 0]];
  return Array.from({ length: n }, (_, k) => {
    const r = Math.sqrt((k + 0.5) / n), a = k * 2.399963229728653;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
}

/** Add one rendered sample (bytes) into a running total. */
export function addSample(sum, px) {
  for (let i = 0; i < px.length; i++) sum[i] += px[i];
}

/**
 * Average `n` summed samples into RGBA bytes. The samples come from WebGL, bottom row first, so rows are flipped.
 * With `keepAlpha` the samples are colour already multiplied by coverage; the result is plain colour plus alpha,
 * which is what a PNG stores. Without it the result is opaque.
 */
export function resolveSamples(sum, n, width, height, out, keepAlpha = false) {
  for (let y = 0; y < height; y++) {
    let s = (height - 1 - y) * width * 4, o = y * width * 4;
    for (let x = 0; x < width; x++, s += 4, o += 4) {
      if (keepAlpha) {
        const a = sum[s + 3] / n, k = a > 0 ? 255 / (a * n) : 0;
        out[o] = Math.min(255, sum[s] * k + 0.5); out[o + 1] = Math.min(255, sum[s + 1] * k + 0.5); out[o + 2] = Math.min(255, sum[s + 2] * k + 0.5);
        out[o + 3] = a + 0.5;
      } else {
        out[o] = sum[s] / n + 0.5; out[o + 1] = sum[s + 1] / n + 0.5; out[o + 2] = sum[s + 2] / n + 0.5; out[o + 3] = 255;
      }
    }
  }
  return out;
}

/** Focus distance at a time from keys [{ t, distance }] sorted by time, easing between them (a focus pull). */
export function focusAt(keys, time) {
  if (time <= keys[0].t) return keys[0].distance;
  const last = keys[keys.length - 1];
  if (time >= last.t) return last.distance;
  let i = 0;
  while (keys[i + 1].t <= time) i++;
  const a = keys[i], b = keys[i + 1];
  let u = (time - a.t) / (b.t - a.t);
  u = u * u * (3 - 2 * u);
  return a.distance + (b.distance - a.distance) * u;
}
