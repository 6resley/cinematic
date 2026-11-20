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
