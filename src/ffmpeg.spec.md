# ffmpeg.js contract

Self-contained Node module. Only dependencies: `ffmpeg-static` (with fallback to
system `ffmpeg` on PATH) + Node builtins (`child_process.execFile`, `fs`, `path`).

## Export

```js
convert(inputPath, targetFormat, compress = false, outDir = null) => Promise<absoluteOutputPath>
```

- `inputPath`: existing file (image or video).
- `targetFormat`: one of `PNG JPEG WEBP GIF AVIF MP4 WEBM MOV MKV AVI`
  (case-insensitive).
- `compress`:
  - `false` (default): lossless / high-bitrate encoders.
  - `true`: high-quality lossy (video: H.264 CRF 23 + AAC 160k, or format-appropriate
    lossy codec; images: lossy encoders at high quality).
- `outDir`: output directory; default `/tmp/ffmpeg-out`. Created if missing.
- Output filename: source basename without extension + `.` + lowercased target ext
  (e.g. `test-video.mp4` -> `test-video.mkv`).
- Resolves to the **absolute** output path.

## Behavior

1. Resolve the ffmpeg binary: `require('ffmpeg-static')` first; fall back to
   `ffmpeg` on PATH. ffprobe: `require('ffmpeg-static')` path + `/ffprobe` if it
   exists, else `ffprobe` on PATH.
2. Detect image vs video: probe with `ffprobe -hide_banner -show_format`
   (missing program / non-zero exit / JSON error falls back to extension inference).
3. Build per-format codec args:
   - Images: PNG (lossless, both modes), JPEG (lossy q90 / lossless `-lossless`
     approximated via `-qscale 1`... use `-quality 100` semantics: compress=true ->
     `-quality 90`, compress=false -> `-quality 100`... spec: "lossless/high-bitrate"
     => use `-quality 100` equivalent; for JPEG that's `-qscale:v 1`... simpler:
     compress=true -> `-quality 90`; compress=false -> `-quality 100`),
     WEBP (lossy q90 / lossy q100), GIF (two-pass palettegen + paletteuse;
     compress=true -> max colors 256 faststart dither none? keep Bayer;
     compress=false -> `-giftrans`... keep simple: pass1
     `palettegen [stats-mode]`, pass2 `paletteuse`),
     AVIF via `libaom-av1` (`-c:v libaom-av1 -cpu-used 4 -aom-flags still-image`;
     compress=true -> `-crf 30 -b:v 0`, compress=false -> `-crf 34 -b:v 0`...
     high quality: crf 32 default; keep `-crf 32` both, -crf 36 lossy) — decide in code.
   - Video:
     - MP4: H.264 + AAC. compress=true -> `-c:v libx264 -crf 23 -c:a aac -b:a 160k`;
       compress=false -> `-c:v libx264 -crf 0` (lossless) or `-crf 16`? "lossless"
       -> `-crf 0 -preset veryslow -c:a pcm_s16le`... MP4 with pcm is nonstandard;
       use `-crf 0 -preset ultrafast` video + `-c:a aac -b:a 256k` (near-lossless)
       or keep original audio copy when possible.
     - WEBM: VP8/VP9 + Vorbis/Opus. compress=true -> `-c:v libvpx-vp9 -crf 30
       -b:v 0 -c:a libopus -b:a 128k`; compress=false -> VP9 `-crf 0 -b:v 0`
       lossless + `-c:a pcm_s16`? WebM supports pcm in flac; use `-c:a libvorbis -q:a 10`.
     - MOV: H.264 (libx264) + aac.
     - MKV: libx264 + aac (or copy video when source compatible... keep re-encode).
     - AVI: mpeg4 + pcm_s16le (no H.264/AVI in default ffmpeg-static build? mpeg4
       is in libavcodec core, safe).
4. GIF: two-pass palettegen + paletteuse with a temp palette file in outDir.
5. AVIF: `libaom-av1` with `-cpu-used` for speed, high quality.
6. Run via `child_process.execFile` (never `exec`). On non-zero exit, reject with
   an Error whose message includes stderr text.
7. `fs.mkdirSync(outDir, {recursive: true})` when outDir is null/missing.
8. Return `path.resolve(out, outputName)`.

## Failure modes

- Unknown/unsupported target format -> reject `Support`... no: reject
  `Error("Unsupported target format: X")`.
- Input not found -> reject with ENOENT message.
- ffmpeg/ffprobe non-zero exit -> reject with stderr included.
