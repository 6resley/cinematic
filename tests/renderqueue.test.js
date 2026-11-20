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
