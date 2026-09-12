'use strict';
// Minimal verification for src/ffmpeg.js against its spec (ffmpeg.spec.md).
// Real FFmpeg runs; safe with test fixtures in repo root.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { convert } = require('../src/ffmpeg.js');
const BASE = path.join(__dirname, '..');
const OUT = '/tmp/ffmpeg-test-out';

function sizeOf(p) {
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

test('ffmpeg binary resolves', () => {
  const bin = require('ffmpeg-static');
  assert.ok(typeof bin === 'string' && fs.existsSync(bin), `binary not found: ${bin}`);
});

test('convert() rejects unsupported target', async () => {
  await assert.rejects(
    convert(path.join(BASE, 'test-image.png'), 'tiff'),
    (e) => e.message.includes('Unsupported')
  );
});

test('convert() rejects missing input', async () => {
  await assert.rejects(
    convert('/no/such/file.png', 'jpeg'),
    (e) => e.message.includes('Input file not found')
  );
});

test('video: MP4/WEBM/MKV/MOV/AVI compressed + MP4 uncompressed', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const src = path.join(BASE, 'test-video.mp4');
  const jobs = [
    ['mp4', true], ['mp4', false], ['webm', true], ['mkv', true],
    ['mov', true], ['avi', true], ['webm', false],
  ];
  for (const [target, compress] of jobs) {
    const out = await convert(src, target, compress, OUT);
    assert.ok(out.startsWith('/'), `absolute path: ${out}`);
    assert.ok(sizeOf(out) > 0, `${target} compress=${compress} produced empty output`);
  }
});

test('image: JPEG/WEBP/GIF/AVIF both compress settings', async () => {
  const src = path.join(BASE, 'test-image.png');
  for (const target of ['jpeg', 'webp', 'gif', 'avif']) {
    for (const compress of [true, false]) {
      const out = await convert(src, target, compress, OUT);
      assert.ok(sizeOf(out) > 0, `${target} compress=${compress} produced empty output`);
    }
  }
});

test('output naming: jpeg -> .jpg, others -> lowercased ext', async () => {
  const out = await convert(path.join(BASE, 'test-image.png'), 'JPEG', false, OUT);
  assert.strictEqual(out, path.join(OUT, 'test-image.jpg'));
});

test('default outDir is /tmp/ffmpeg-out', async () => {
  const out = await convert(path.join(BASE, 'test-image.png'), 'gif');
  assert.strictEqual(out, '/tmp/ffmpeg-out/test-image.gif');
});

test('failed ffmpeg run surfaces stderr text', async () => {
  // package.json exists but is not decodable media; ffmpeg exits non-zero
  await assert.rejects(
    convert(path.join(BASE, 'package.json'), 'mp4', false, OUT),
    (e) => /Command failed/.test(e.message) && e.message.length > 50
  );
});
