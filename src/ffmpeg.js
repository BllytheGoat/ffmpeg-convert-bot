'use strict';

/**
 * ffmpeg.js — self-contained FFmpeg wrapper.
 *
 * Contract: see ./ffmpeg.spec.md
 *   convert(inputPath, targetFormat, compress=false, outDir=null)
 *     => Promise<absoluteOutputPath>
 *
 * Supported target formats:
 *   Images: PNG, JPEG, WEBP, GIF, AVIF
 *   Video:  MP4, WEBM, MOV, MKV, AVI
 *
 * Uses child_process.execFile (never exec) to avoid shell injection.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_OUT_DIR = '/tmp/ffmpeg-out';

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveFfmpeg() {
  try {
    const bin = require('ffmpeg-static');
    if (bin && typeof bin === 'string' && fs.existsSync(bin)) {
      return bin;
    }
  } catch (_) {
    /* fall through to PATH */
  }
  return 'ffmpeg';
}

function resolveFfprobe() {
  try {
    const staticDir = require.resolve('ffmpeg-static');
    const maybe = path.join(path.dirname(staticDir), 'ffprobe');
    if (fs.existsSync(maybe)) return maybe;
  } catch (_) {
    /* fall through to PATH */
  }
  return 'ffprobe';
}

const INPUT_EXT_HINTS = {
  png: 'image',
  jpg: 'image', jpeg: 'image',
  webp: 'image',
  gif: 'image',
  avif: 'image',
  bmp: 'image', tiff: 'image', tif: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
  m4v: 'video', wmv: 'video', flv: 'video', mpeg: 'video', mpg: 'video',
};

// ---------------------------------------------------------------------------
// execFile helper
// ---------------------------------------------------------------------------

/**
 * Run `file` with `args`. Rejects with an Error whose message includes
 * stderr text on non-zero exit.
 */
function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr && stderr.trim() ? `\n--- ffmpeg stderr ---\n${stderr.trim()}` : '';
        reject(new Error(`Command failed (exit ${err.code ?? 'non-zero'}): ${file} ${args.join(' ')}${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Media type detection
// ---------------------------------------------------------------------------

/**
 * Probe input with ffprobe; fall back to extension guessing.
 * Returns 'image' or 'video'.
 */
async function detectKind(inputPath) {
  const probe = resolveFfprobe();
  try {
    const { stdout } = await run(probe, [
      '-hide_banner',
      '-show_format',
      '-of', 'json',
      inputPath,
    ]);
    const json = JSON.parse(stdout);
    const fmt = json?.format;
    const name = String(fmt?.format_name || '');
    const longName = String(fmt?.format_long_name || '');
    const hasVideo = /video/i.test(name) || /video/i.test(longName);
    const isMuxedImage =
      name === 'image2' || name === 'lavfi' || /png|jpeg|webp|gif|avif|bmp|tiff/i.test(name);
    if (hasVideo && !isMuxedImage) return 'video';
    if (isMuxedImage && !hasVideo) return 'image';
    // Ambiguous (image muxers sometimes report weird format names): fall through.
  } catch (_) {
    /* probe failed — use extension */
  }
  const ext = path.extname(inputPath).replace('.', '').toLowerCase();
  const hint = INPUT_EXT_HINTS[ext];
  if (hint === 'image') return 'image';
  if (hint === 'video') return 'video';
  // Default: if we got here, treat as video (ffmpeg will tell us on failure).
  return 'video';
}

// ---------------------------------------------------------------------------
// Format-specific argument builders
//
// Each returns { args, needsPalette } where args is the array of ffmpeg args
// following `-i input` (i.e. output-side args including -y are added later).
// ---------------------------------------------------------------------------

function imageArgs(target, compress, outPath) {
  switch (target) {
    case 'png':
      // PNG is lossless in either mode.
      return { args: ['-c:v', 'png', outPath] };
    case 'jpeg':
    case 'jpg':
      // JPEG: -quality 0..100 scale for ffmpeg's mjpeg encoder.
      return { args: ['-c:v', 'mjpeg', '-quality', compress ? '85' : '100', '-y', outPath] };
    case 'webp':
      // libwebp: -quality 0..100 (100 = lossless-ish, high bitrate).
      return { args: ['-c:v', 'libwebp', '-quality', compress ? '85' : '100', '-y', outPath] };
    case 'gif':
      // Two-pass palettegen + paletteuse. Palette file sits in outDir (or /tmp).
      {
        const palette = path.join(path.dirname(outPath), `__palette_${path.basename(outPath, path.extname(outPath))}.png`);
        return {
          needsPalette: true,
          paletteFile: palette,
          args: null, // caller runs two commands
          gifOutput: outPath,
        };
      }
    case 'avif':
      // libaom-av1. -cpu-used 4: fast-ish but still good quality.
      // -crf is a raw option: compress=true -> 30 (lossy, smaller),
      // compress=false -> 24 (high quality).
      {
        const crf = compress ? '30' : '24';
        return {
          args: [
            '-c:v', 'libaom-av1',
            '-crf', crf,
            '-cpu-used', '4',
            '-y', outPath,
          ],
        };
      }
    default:
      throw new Error(`Unsupported image target format: ${target}`);
  }
}

function videoArgs(target, compress, outPath) {
  switch (target) {
    case 'mp4':
      if (compress) {
        // High-quality lossy: H.264 CRF 23 + AAC 160k (per spec).
        return {
          args: [
            '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k',
            '-movflags', '+faststart',
            '-y', outPath,
          ],
        };
      }
      // Lossless video (CRF 0) + high-bitrate AAC audio.
      return {
        args: [
          '-c:v', 'libx264', '-crf', '0', '-preset', 'veryfast',
          '-pix_fmt', 'yuv444p',
          '-c:a', 'aac', '-b:a', '256k',
          '-movflags', '+faststart',
          '-y', outPath,
        ],
      };
    case 'webm':
      if (compress) {
        return {
          args: [
            '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
            '-c:a', 'libopus', '-b:a', '128k',
            '-y', outPath,
          ],
        };
      }
      // Lossless VP9 (CRF 0) + high-bitrate Vorbis audio.
      return {
        args: [
          '-c:v', 'libvpx-vp9', '-crf', '0', '-b:v', '0',
          '-cpu-used', '2',
          '-c:a', 'libvorbis', '-q:a', '10',
          '-y', outPath,
        ],
      };
    case 'mov':
      if (compress) {
        return {
          args: [
            '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k',
            '-y', outPath,
          ],
        };
      }
      // High-bitrate (near-lossless) H.264 + high-bitrate AAC.
      return {
        args: [
          '-c:v', 'libx264', '-crf', '0', '-preset', 'veryfast',
          '-pix_fmt', 'yuv444p',
          '-c:a', 'aac', '-b:a', '256k',
          '-y', outPath,
        ],
      };
    case 'mkv':
      if (compress) {
        return {
          args: [
            '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
            '-c:a', 'aac', '-b:a', '160k',
            '-y', outPath,
          ],
        };
      }
      // Lossless H.264 video; audio copied (MKV carries the original AAC fine).
      return {
        args: [
          '-c:v', 'libx264', '-crf', '0', '-preset', 'veryfast',
          '-c:a', 'copy',
          '-y', outPath,
        ],
      };
    case 'avi':
      // mpeg4 is a core codec (always available); AVI uses PCM audio.
      if (compress) {
        return {
          args: [
            '-c:v', 'mpeg4', '-q:v', '3',
            '-c:a', 'pcm_s16le',
            '-y', outPath,
          ],
        };
      }
      return {
        args: [
          '-c:v', 'mpeg4', '-q:v', '1',
          '-c:a', 'pcm_s16le',
          '-y', outPath,
        ],
      };
    default:
      throw new Error(`Unsupported video target format: ${target}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert `inputPath` to `targetFormat`.
 *
 * @param {string} inputPath  Source file (image or video).
 * @param {string} targetFormat  e.g. 'png', 'jpeg', 'webp', 'gif', 'avif',
 *   'mp4', 'webm', 'mov', 'mkv', 'avi' (case-insensitive).
 * @param {boolean} [compress]  false => lossless/high-bitrate,
 *   true => high-quality lossy.
 * @param {string|null} [outDir]  Output directory; default /tmp/ffmpeg-out.
 * @returns {Promise<string>} absolute output path.
 */
async function convert(inputPath, targetFormat, compress = false, outDir = null) {
  const ffmpegBin = resolveFfmpeg();
  const out = outDir ? path.resolve(outDir) : DEFAULT_OUT_DIR;
  fs.mkdirSync(out, { recursive: true });

  const srcAbs = path.resolve(inputPath);
  if (!fs.existsSync(srcAbs)) {
    throw new Error(`Input file not found: ${srcAbs}`);
  }

  const target = String(targetFormat).toLowerCase();
  const kind = await detectKind(srcAbs);

  const ext = path.extname(srcAbs).replace('.', '').toLowerCase();
  const baseNoExt = path.basename(srcAbs, path.extname(srcAbs));
  const outName = target === 'jpeg' ? `${baseNoExt}.jpg` : `${baseNoExt}.${target}`;
  const outPath = path.resolve(out, outName);

  const sourceArgs = ['-hide_banner', '-loglevel', 'error', '-i', srcAbs];

  if (kind === 'image') {
    const spec = imageArgs(target, compress, outPath);

    if (spec.needsPalette) {
      // --- GIF two-pass: palettegen ---
      const pass1 = [
        ...sourceArgs,
        '-vf',
        `palettegen=max_colors=${compress ? 128 : 256}`,
        '-y',
        spec.paletteFile,
      ];
      await run(ffmpegBin, pass1);

      // --- GIF two-pass: paletteuse ---
      const pass2 = [
        ...sourceArgs,
        '-i', spec.paletteFile,
        '-lavfi',
        compress
          ? '[0:v][1:v]paletteuse=dither=bayer:bayer_scale=5'
          : '[0:v][1:v]paletteuse',
        '-y',
        spec.gifOutput,
      ];
      await run(ffmpegBin, pass2);

      // Clean up the temporary palette.
      try { fs.unlinkSync(spec.paletteFile); } catch (_) { /* ignore */ }
      return outPath;
    }

    await run(ffmpegBin, [...sourceArgs, ...spec.args]);
    return outPath;
  }

  // --- video ---
  const spec = videoArgs(target, compress, outPath);
  await run(ffmpegBin, [...sourceArgs, ...spec.args]);
  return outPath;
}

module.exports = { convert };
module.exports.default = convert; // ESM interop
