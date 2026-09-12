// src/meta.js — compact media "ID card" extractor.
// Uses ffprobe-static (fallback: ffprobe on PATH) to return a one-line
// summary the bot shows to the user so they can trust the file was read.
//
//   describeFile(path, mimeHint) => Promise<string>
//
// Returns e.g. "video · H.264 · 1920×1080 · 0:42 · 8.2 MB" or
//              "image · PNG · 1280×720 · 1.4 MB".
// Never throws: on any probe failure it falls back to a mime/size-only line.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function resolveFfprobe() {
  try {
    const p = require('ffprobe-static');
    const bin = typeof p === 'string' ? p : p.path;
    if (bin && fs.existsSync(bin)) return bin;
  } catch (_) {}
  return 'ffprobe';
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout);
    });
  });
}

function humanSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// The container's codec family label we surface, humanized.
function codecLabel(codec) {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c.includes('264') || c === 'h264') return 'H.264';
  if (c.includes('265') || c === 'hevc' || c === 'h265') return 'HEVC';
  if (c === 'vp8') return 'VP8';
  if (c === 'vp9') return 'VP9';
  if (c === 'av1') return 'AV1';
  if (c === 'mpeg4') return 'MPEG-4';
  if (c === 'h261' || c === 'mjpeg') return 'MJPEG';
  if (c === 'gif') return 'GIF';
  if (c === 'png') return 'PNG';
  if (c === 'jpeg' || c === 'mjpeg') return 'JPEG';
  if (c === 'webp') return 'WebP';
  if (c === 'avif') return 'AVIF';
  return codec;
}

/**
 * Build a compact, human-readable one-line description of the media file.
 * @param {string} filePath absolute path to the file.
 * @param {string} [mimeHint] optional MIME type to disambiguate.
 * @returns {Promise<string>}
 */
async function describeFile(filePath, mimeHint) {
  let size;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch (_) {
    size = null;
  }

  const probe = resolveFfprobe();
  const stdout = await run(probe, [
    '-hide_banner',
    '-loglevel', 'error',
    '-of', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  let format = {};
  let streams = [];
  if (stdout) {
    try {
      const j = JSON.parse(stdout);
      format = j.format || {};
      streams = Array.isArray(j.streams) ? j.streams : [];
    } catch (_) {
      /* probe parse failed; fall back to metadata-only line below */
    }
  }

  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');

  // A still image is a single-frame "video stream" in ffprobe terms, so trust
  // the MIME hint for image vs video when it's specific; otherwise fall back
  // to frame/duration inspection (image containers report 1 frame / no duration).
  const mime = (mimeHint || '').toLowerCase();
  let kind;
  if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';
  else {
    const isStill = !format.duration || (v && v.nb_frames === 1);
    kind = isStill ? 'image' : 'video';
  }
  const isVideo = kind === 'video';

  const parts = [];
  parts.push(kind);

  const codec = isVideo
    ? codecLabel(v ? v.codec_name : null)
    : codecLabel(v ? v.codec_name : (mimeHint || ''));
  if (codec) parts.push(codec);

  const w = v ? v.width : null;
  const h = v ? v.height : null;
  if (w && h) parts.push(`${w}×${h}`);

  const dur = format.duration ? parseFloat(format.duration) : null;
  const d = formatDuration(dur);
  if (isVideo && d) parts.push(d);

  const sz = humanSize(size);
  if (sz) parts.push(sz);

  return parts.join(' · ');
}

module.exports = { describeFile };
