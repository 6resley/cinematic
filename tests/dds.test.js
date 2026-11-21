import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDDS, gameNormalToStandard, gameSpecToRoughness, alphaProfile, applyCamo } from '../src/dds.js';

function header(width, height, { fourcc = null, bits = 0 } = {}) {
  const h = new Uint8Array(128), v = new DataView(h.buffer);
  v.setUint32(0, 0x20534444, true); v.setUint32(4, 124, true);
  v.setUint32(12, height, true); v.setUint32(16, width, true);
  v.setUint32(76, 32, true);
  if (fourcc) { v.setUint32(80, 0x4, true); for (let i = 0; i < 4; i++) h[84 + i] = fourcc.charCodeAt(i); }
  else { v.setUint32(80, 0x41, true); v.setUint32(88, bits, true); }
  return h;
}
const join = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const px = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('rejects things that are not DDS files', () => {
  assert.throws(() => decodeDDS(new Uint8Array(200)));
  assert.throws(() => decodeDDS(new Uint8Array(10)));
});

test('DXT1 block: end-point colours and the two blends', () => {
  // colour0 = pure red (0xF800), colour1 = pure blue (0x001F); row 0 uses indices 0,1,2,3
  const block = new Uint8Array([0x00, 0xF8, 0x1F, 0x00, 0b11100100, 0, 0, 0]);
  const img = decodeDDS(join(header(4, 4, { fourcc: 'DXT1' }), block));
  assert.deepEqual(px(img, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(img, 2, 0), [170, 0, 85, 255]);
  assert.deepEqual(px(img, 3, 0), [85, 0, 170, 255]);
  assert.deepEqual(px(img, 0, 1), [255, 0, 0, 255]);
});

test('DXT1 with colour0 <= colour1 has a transparent entry', () => {
  const block = new Uint8Array([0x1F, 0x00, 0x00, 0xF8, 0b11100100, 0, 0, 0]);    // blue, red: three-colour mode
  const img = decodeDDS(join(header(4, 4, { fourcc: 'DXT1' }), block));
  assert.deepEqual(px(img, 2, 0), [128, 0, 128, 255]);
  assert.deepEqual(px(img, 3, 0), [0, 0, 0, 0]);
});

test('DXT5 block: interpolated alpha', () => {
  // alpha end points 255 and 0; pixel 0 uses index 0, pixel 1 index 1, pixel 2 index 2
  const alpha = new Uint8Array([255, 0, 0b10001000, 0b00000000, 0, 0, 0, 0]);
  const colour = new Uint8Array([0xFF, 0xFF, 0x00, 0x00, 0, 0, 0, 0]);            // white everywhere
  const img = decodeDDS(join(header(4, 4, { fourcc: 'DXT5' }), alpha, colour));
  assert.deepEqual(px(img, 0, 0), [255, 255, 255, 255]);
  assert.equal(px(img, 1, 0)[3], 0);
  assert.equal(px(img, 2, 0)[3], 218);                                            // (6*255 + 0) / 7, rounded down like reference decoders
});

test('DXT3 block: explicit 4-bit alpha', () => {
  const alpha = new Uint8Array([0xF0, 0, 0, 0, 0, 0, 0, 0]);                      // pixel 0 -> 0, pixel 1 -> 15
  const colour = new Uint8Array([0xFF, 0xFF, 0x00, 0x00, 0, 0, 0, 0]);
  const img = decodeDDS(join(header(4, 4, { fourcc: 'DXT3' }), alpha, colour));
  assert.equal(px(img, 0, 0)[3], 0);
  assert.equal(px(img, 1, 0)[3], 255);
});

test('uncompressed 32-bit is BGRA on disk', () => {
  const img = decodeDDS(join(header(1, 1, { bits: 32 }), new Uint8Array([10, 20, 30, 40])));
  assert.deepEqual(px(img, 0, 0), [30, 20, 10, 40]);
});

test('sizes that are not a multiple of four are cropped correctly', () => {
  const block = new Uint8Array([0x00, 0xF8, 0x1F, 0x00, 0, 0, 0, 0]);
  const img = decodeDDS(join(header(2, 2, { fourcc: 'DXT1' }), block));
  assert.equal(img.data.length, 16);
  assert.deepEqual(px(img, 1, 1), [255, 0, 0, 255]);
});

test('truncated files are reported', () => {
  assert.throws(() => decodeDDS(header(8, 8, { fourcc: 'DXT1' })), /cut short/);
});

test('game normal map becomes a standard one', () => {
  // flat surface: X (alpha) and Y (green) both at the midpoint
  const img = gameNormalToStandard({ width: 1, height: 1, data: new Uint8Array([0, 128, 0, 128]) });
  const [r, g, b, a] = img.data;
  assert.equal(r, 128); assert.equal(g, 127); assert.ok(b >= 254); assert.equal(a, 255);
  // tilted fully along X: Z collapses to the midpoint
  const tilted = gameNormalToStandard({ width: 1, height: 1, data: new Uint8Array([0, 128, 0, 255]) });
  assert.equal(tilted.data[0], 255); assert.ok(Math.abs(tilted.data[2] - 128) <= 12);
});

test('specular gloss becomes roughness in green', () => {
  const shiny = gameSpecToRoughness({ width: 1, height: 1, data: new Uint8Array([9, 9, 9, 222]) });
  assert.deepEqual([...shiny.data], [255, 0, 0, 255]);
  const matte = gameSpecToRoughness({ width: 1, height: 1, data: new Uint8Array([9, 9, 9, 0]) });
  assert.deepEqual([...matte.data], [255, 255, 0, 255]);
});

test('alpha profile separates cut-out from solid textures', () => {
  const cut = alphaProfile({ data: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0]) });
  assert.equal(cut.clear, 0.5); assert.equal(cut.solid, 0.5);
  const solid = alphaProfile({ data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 250]) });
  assert.equal(solid.clear, 0); assert.equal(solid.solid, 1);
});

test('camo: mid-grey paint leaves the base alone, and the mask controls how much paint takes', () => {
  const grey = { width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]) };
  const base = () => ({ width: 2, height: 1, data: new Uint8Array([100, 100, 100, 255, 100, 100, 100, 0]) });
  const same = applyCamo(base(), grey);
  assert.ok(Math.abs(same.data[0] - 100) <= 1);
  const red = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) };
  const painted = applyCamo(base(), red);
  assert.deepEqual([...painted.data.slice(0, 4)], [200, 0, 0, 255]);        // fully masked in: base x paint x 2
  assert.deepEqual([...painted.data.slice(4, 8)], [100, 100, 100, 255]);    // masked out: untouched, made opaque
});

test('camo: the pattern repeats across the texture', () => {
  const stripes = { width: 2, height: 1, data: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]) };
  const base = { width: 8, height: 1, data: new Uint8Array(32).fill(255) };
  for (let i = 0; i < 8; i++) base.data.set([100, 100, 100, 255], i * 4);
  const out = applyCamo(base, stripes, 2);
  const v = [...Array(8)].map((_, i) => out.data[i * 4]);
  assert.deepEqual(v.slice(0, 4), v.slice(4, 8));                           // two identical repeats
  assert.ok(Math.max(...v) > 140 && Math.min(...v) < 60);                   // light and dark stripes both show
});
