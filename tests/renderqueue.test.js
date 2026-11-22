import test from 'node:test';
import assert from 'node:assert/strict';
import { frameTimes, subframeTimes, frameName, safeName } from '../src/renderqueue.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('frame times cover the range at the job rate, not the timeline rate', () => {
  const t = frameTimes(0, 1, 60);
  assert.equal(t.length, 60);
  close(t[0], 0); close(t[1], 1 / 60); close(t[59], 59 / 60);
  assert.equal(frameTimes(2, 2.5, 240).length, 120);
  close(frameTimes(2, 2.5, 240)[0], 2);
});

test('an empty or backwards range still renders one frame', () => {
  assert.equal(frameTimes(3, 3, 60).length, 1);
  assert.equal(frameTimes(3, 2, 60).length, 1);
});

test('one sample means no blur: just the frame time', () => {
  assert.deepEqual(subframeTimes(1.5, 60, 1), [1.5]);
});

test('blur samples spread across half the frame interval by default', () => {
  const s = subframeTimes(1, 60, 4);
  assert.equal(s.length, 4);
  close(s[0], 1);
  close(s[3], 1 + 0.75 * (0.5 / 60));
  assert.ok(s[3] < 1 + 1 / 60);
});

test('a wider shutter spreads samples further', () => {
  close(subframeTimes(0, 30, 2, 1)[1], 0.5 / 30);
});

test('frame files are numbered from 1 and zero padded', () => {
  assert.equal(frameName('shot', 0), 'shot_00001.png');
  assert.equal(frameName('shot', 1234), 'shot_01235.png');
});

test('job names become safe file names', () => {
  assert.equal(safeName('Intro shot #1'), 'Intro_shot_1');
  assert.equal(safeName('   '), 'shot');
  assert.equal(safeName('a/b\\c:d'), 'a_b_c_d');
});

import { lensOffsets, addSample, resolveSamples, focusAt } from '../src/renderqueue.js';

test('lens points stay inside the lens and are centred', () => {
  const pts = lensOffsets(24);
  assert.equal(pts.length, 24);
  assert.ok(pts.every(([x, y]) => Math.hypot(x, y) <= 1));
  const mean = pts.reduce((m, [x, y]) => [m[0] + x / 24, m[1] + y / 24], [0, 0]);
  assert.ok(Math.hypot(...mean) < 0.08);
  assert.deepEqual(lensOffsets(1), [[0, 0]]);
});

test('samples average to an opaque image, flipped the right way up', () => {
  const sum = new Uint16Array(2 * 2 * 4);                    // 1 px wide, 2 px tall
  addSample(sum, new Uint8Array([10, 20, 30, 255, 200, 100, 0, 255]));
  addSample(sum, new Uint8Array([30, 40, 50, 255, 100, 100, 0, 255]));
  const out = resolveSamples(sum, 2, 1, 2, new Uint8ClampedArray(8));
  assert.deepEqual([...out], [150, 100, 0, 255, 20, 30, 40, 255]);          // the bottom row from WebGL ends up last
});

test('transparent averaging keeps the colour of half-covered pixels', () => {
  const sum = new Uint16Array(4);
  addSample(sum, new Uint8Array([200, 100, 0, 255]));       // covered in one sample
  addSample(sum, new Uint8Array([0, 0, 0, 0]));             // empty in the other
  const out = resolveSamples(sum, 2, 1, 1, new Uint8ClampedArray(4), true);
  assert.deepEqual([...out], [200, 100, 0, 128]);
  const empty = resolveSamples(new Uint16Array(4), 2, 1, 1, new Uint8ClampedArray(4), true);
  assert.deepEqual([...empty], [0, 0, 0, 0]);
});

test('focus pulls ease between keys and hold outside them', () => {
  const keys = [{ t: 1, distance: 2 }, { t: 3, distance: 10 }];
  assert.equal(focusAt(keys, 0), 2);
  assert.equal(focusAt(keys, 5), 10);
  assert.equal(focusAt(keys, 2), 6);
  assert.ok(focusAt(keys, 1.2) < 2 + 8 * 0.1);              // slow start
});
