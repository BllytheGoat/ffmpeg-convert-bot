'use strict';

// src/ffmpeg.js
// Self-contained FFmpeg conversion wrapper.
// Dependencies: `ffmpeg-static` (falls back to system `ffmpeg`/`ffprobe` on PATH)
// and Node builtins (fs, path, os, child_process.execFile — never exec).
//
// Contract:
//   convert(inputPath, targetFormat, compress = false, outDir = null)
//     => Promise<string>  (absolute path to the converted file)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_OUT_DIR = '/tmp/ffmpeg-out';

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveFfmpeg() {
  try {
    const bin = require('ffmpeg-static');
    if (bin && typeof bin === 'string' && fs.existsSync(bin)) return bin;
  } catch (_) {
    /* ffmpeg-static not installed / broken -> fall back to PATH */
  }
  return 'ffmpeg';
}

function resolveFfprobe() {
  // Prefer an ffprobe shipped next to the ffmpeg-static binary; else PATH.
  try {
    const bin = require('ffmpeg-static');
    if (bin && typeof bin === 'string') {
      const maybe = path.join(path.dirname(bin), 'ffprobe');
      if (fs.existsSync(maybe)) return maybe;
    }
  } catch (_) {
    /* fall through */
  }
  return 'ffprobe';
}

// ---------------------------------------------------------------------------
// execFile helper (rejects with stderr on non-zero exit)
// ---------------------------------------------------------------------------

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr && stderr.trim() ? stderr.trim() : err.message;
          reject(new Error(`Command failed (exit ${err.code ?? 'non-zero'}): ${file}\n${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Media type detection (ffprobe -hide_banner -show_format, then extension)
// ---------------------------------------------------------------------------

const EXT_HINTS = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
  avif: 'image', bmp: 'image', tiff: 'image', tif: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
  m4v: 'video', wmv: 'video', flv: 'video', mpg: 'video', mpeg: 'video',
};

async function detectKind(inputPath, mimeHint = '') {
  // Fast path: an authoritative MIME hint (e.g. from Telegram) decides
  // without probing. This keeps detection cheap and deterministic when the
  // caller already knows the content type.
  const mime = String(mimeHint || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';

  const probe = resolveFfprobe();
  try {
    const { stdout } = await run(probe, [
      '-hide_banner', '-show_format', '-of', 'json', inputPath,
    ]);
    const json = JSON.parse(stdout);
    const fmt = json && json.format ? json.format : {};
    const name = String(fmt.format_name || '');
    const longName = String(fmt.format_long_name || '');
    const streamType = json && Array.isArray(json.streams)
      ? json.streams.map((s) => s.codec_type).join(',')
      : '';
    const looksVideo = /video/i.test(streamType) || /video/i.test(name + ' ' + longName);
    const looksImageMuxer =
      /image2|png|jpeg|webp|gif|avif|bmp|tiff/i.test(name) ||
      (streamType === '' && /image/i.test(name + ' ' + longName));
    if (looksVideo && !looksImageMuxer) return 'video';
    if (looksImageMuxer && !looksVideo) return 'image';
    // Ambiguous (image muxers sometimes report odd names); fall through.
  } catch (_) {
    /* probe failed — use extension inference */
  }
  const ext = path.extname(inputPath).replace('.', '').toLowerCase();
  if (EXT_HINTS[ext] === 'image') return 'image';
  if (EXT_HINTS[ext] === 'video') return 'video';
  return 'video'; // default assumption for unknown inputs
}

// ---------------------------------------------------------------------------
// Format → codec args
// ---------------------------------------------------------------------------

const SUPPORTED = ['PNG', 'JPEG', 'WEBP', 'GIF', 'AVIF', 'MP4', 'WEBM', 'MOV', 'MKV', 'AVI'];

const FORMAT_EXT = {
  PNG: 'png', JPEG: 'jpg', WEBP: 'webp', GIF: 'gif', AVIF: 'avif',
  MP4: 'mp4', WEBM: 'webm', MOV: 'mov', MKV: 'mkv', AVI: 'avi',
};

/**
 * Args for image output (single frame). Returns { args } where args is
 * everything after `-i <input>`.
 */
function imageArgs(target, compress) {
  switch (target) {
    case 'PNG':
      // PNG is inherently lossless; nothing to tune.
      return ['-c:v', 'png'];
    case 'JPEG':
      // mjpeg encoder: -quality 0..100. compress -> q90, else q100.
      return ['-c:v', 'mjpeg', '-quality', compress ? '90' : '100'];
    case 'WEBP':
      return ['-c:v', 'libwebp', '-quality', compress ? '90' : '100'];
    case 'GIF':
      return null; // handled by two-pass below
    case 'AVIF':
      // libaom-av1 encodes AVIF images. -cpu-used 4 keeps it tractable.
      // compress=true -> crf 36 (aggressive lossy); false -> crf 32 high quality.
      return ['-c:v', 'libaom-av1', '-crf', compress ? '36' : '32',
              '-cpu-used', '4'];
    default:
      throw new Error(`Unsupported image target format: ${target}`);
  }
}

/**
 * Args for video output. Returns { args } (everything after `-i <input>`).
 * Per-container codec combos:
 *   MP4:  H.264 + AAC          WEBM: VP9 + Opus (lossy) / VP9 high + Vorbis
 *   MOV:  H.264 + AAC         MKV:  H.264 + Vorbis (lossless-ish high bitrate)
 *   AVI:  MPEG4 + PCM (core codec; H.264-in-AVI is nonstandard)
 */
function videoArgs(target, compress) {
  switch (target) {
    case 'MP4':
      if (compress) {
        return ['-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
      }
      // Near-lossless: CRF 0 (true lossless H.264), high-bitrate audio.
      return ['-c:v', 'libx264', '-crf', '0', '-preset', 'ultrafast',
              '-c:a', 'aac', '-b:a', '256k'];
    case 'WEBM':
      if (compress) {
        return ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
                '-c:a', 'libopus', '-b:a', '128k'];
      }
      return ['-c:v', 'libvpx-vp9', '-crf', '12', '-b:v', '0',
              '-c:a', 'libvorbis', '-q:a', '10'];
    case 'MOV':
      if (compress) {
        return ['-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '160k'];
      }
      return ['-c:v', 'libx264', '-crf', '0', '-preset', 'ultrafast',
              '-c:a', 'pcm_s16le'];
    case 'MKV':
      if (compress) {
        return ['-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
                '-c:a', 'libvorbis', '-q:a', '8'];
      }
      return ['-c:v', 'libx264', '-crf', '0', '-preset', 'ultrafast',
              '-c:a', 'libvorbis', '-q:a', '10'];
    case 'AVI':
      // Core mpeg4 codec is always available; pcm audio fits AVI.
      if (compress) {
        return ['-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'pcm_s16le'];
      }
      return ['-c:v', 'mpeg4', '-q:v', '1', '-c:a', 'pcm_s16le'];
    default:
      throw new Error(`Unsupported video target format: ${target}`);
  }
}

// ---------------------------------------------------------------------------
// GIF two-pass (palettegen + paletteuse)
// ---------------------------------------------------------------------------

async function runGifTwoPass(inputPath, outPath, compress, isImageSource) {
  const ffmpeg = resolveFfmpeg();
  const palette = path.join(
    os.tmpdir(),
    `__pal_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
  );
  try {
    const fps = compress ? '12' : '24';
    const scale = compress ? '480:-1:flags=lanczos' : '640:-1:flags=lanczos';

    // For a still image, palettegen needs an explicit -frames:v 1; the fps
    // filter is only useful for video sources.
    const palFilter = isImageSource
      ? `scale=${scale},palettegen=stats_mode=diff`
      : `fps=${fps},scale=${scale},palettegen=stats_mode=diff`;
    const useFilter = isImageSource
      ? `scale=${scale}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
      : `[0:v]fps=${fps},scale=${scale}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;

    // Pass 1: generate an optimal 256-color palette from the source.
    const pass1Args = isImageSource
      ? [
          '-hide_banner', '-loglevel', 'error',
          '-i', inputPath,
          '-vf', palFilter,
          '-frames:v', '1',
          '-y', palette,
        ]
      : [
          '-hide_banner', '-loglevel', 'error',
          '-i', inputPath,
          '-vf', palFilter,
          '-y', palette,
        ];
    await run(ffmpeg, pass1Args);

    // Pass 2: apply the palette to produce the GIF.
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-i', palette,
      '-lavfi', useFilter,
      '-y', outPath,
    ]);
  } finally {
    try { fs.unlinkSync(palette); } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Image → video: still image wrapped into a short video clip.
// ---------------------------------------------------------------------------

function imageToVideoArgs(target, compress) {
  // 2-second still video so the output is a valid, non-trivial clip.
  // Returned args come AFTER `-i <input>`; the caller prefixes `-loop 1`.
  switch (target) {
    case 'MP4':
      if (compress) {
        return ['-t', '2', '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
                '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart'];
      }
      return ['-t', '2', '-c:v', 'libx264', '-crf', '0', '-preset', 'ultrafast',
              '-pix_fmt', 'yuv420p', '-an'];
    case 'WEBM':
      if (compress) {
        return ['-t', '2', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
                '-pix_fmt', 'yuv420p', '-an'];
      }
      return ['-t', '2', '-c:v', 'libvpx-vp9', '-crf', '12', '-b:v', '0',
              '-pix_fmt', 'yuv420p', '-an'];
    case 'MOV':
      return ['-t', '2', '-c:v', 'libx264', '-crf', compress ? '23' : '0',
              '-preset', compress ? 'medium' : 'ultrafast',
              '-pix_fmt', 'yuv420p', '-an'];
    case 'MKV':
      return ['-t', '2', '-c:v', 'libx264', '-crf', compress ? '23' : '0',
              '-preset', compress ? 'medium' : 'ultrafast',
              '-pix_fmt', 'yuv420p', '-an'];
    case 'AVI':
      return ['-t', '2', '-c:v', 'mpeg4', '-q:v', compress ? '3' : '1',
              '-pix_fmt', 'yuv420p', '-an'];
    default:
      throw new Error(`Unsupported video target format: ${target}`);
  }
}

// Video → image: grab a single frame (first frame) and encode it.
function videoToImageArgs(target, compress) {
  switch (target) {
    case 'PNG':
      return ['-c:v', 'png'];
    case 'JPEG':
      return ['-c:v', 'mjpeg', '-quality', compress ? '90' : '100'];
    case 'WEBP':
      return ['-c:v', 'libwebp', '-quality', compress ? '90' : '100'];
    case 'AVIF':
      return ['-c:v', 'libaom-av1', '-crf', compress ? '36' : '32',
              '-cpu-used', '4'];
    case 'GIF':
      return null; // two-pass handled elsewhere
    default:
      throw new Error(`Unsupported image target format: ${target}`);
  }
}

/**
 * Convert an input file (image or video) to the requested target format.
 *
 * @param {string} inputPath  absolute path to the source file
 * @param {string} targetFormat PNG|JPEG|WEBP|GIF|AVIF|MP4|WEBM|MOV|MKV|AVI (case-insensitive)
 * @param {boolean} [compress=false]
 * @param {string|null} [outDir=null]
 * @returns {Promise<string>} absolute path of the converted file
 */
async function convert(inputPath, targetFormat, compress = false, outDir = null) {
  const target = String(targetFormat || '').toUpperCase().trim();
  if (!SUPPORTED.includes(target)) {
    throw new Error(`Unsupported target format: ${targetFormat}`);
  }
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const destDir = outDir || DEFAULT_OUT_DIR;
  fs.mkdirSync(destDir, { recursive: true });

  const base = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.resolve(destDir, `${base}.${FORMAT_EXT[target]}`);

  const kind = await detectKind(inputPath);
  const ffmpeg = resolveFfmpeg();
  const isVideoTarget = ['MP4', 'WEBM', 'MOV', 'MKV', 'AVI'].includes(target);
  const isImageTarget = !isVideoTarget && target !== 'GIF';

  if (target === 'GIF') {
    // Two-pass palettegen/paletteuse for both image and video sources.
    await runGifTwoPass(inputPath, outPath, compress, kind === 'image');
  } else if (kind === 'image' && isVideoTarget) {
    // Still image wrapped into a short 2s clip in the target container.
    const args = imageToVideoArgs(target, compress);
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-i', inputPath,
      ...args,
      '-y', outPath,
    ]);
  } else if (kind === 'video' && isImageTarget) {
    // Grab the first frame of the video.
    const args = videoToImageArgs(target, compress);
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-frames:v', '1',
      ...args,
      '-y', outPath,
    ]);
  } else {
    const args = (kind === 'image' ? imageArgs : videoArgs)(target, compress);
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      ...args,
      '-y', outPath,
    ]);
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error(`Conversion produced no output: ${outPath}`);
  }
  return outPath;
}

module.exports = { convert, detectKind };
