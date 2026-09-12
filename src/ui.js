// src/ui.js — the bot's design layer (copy + keyboard).
//
// Every user-facing string and the inline keyboard live here so the "look and
// voice" of the bot is one reviewable module. api/index.js keeps only the
// Telegram plumbing (sendMessage, download, session state).
//
// Design intent (frontend-design skill, applied to a media-conversion tool):
//   * ONE memorable element: the media "ID card" — bold filename plus a
//     monospace spec line (codec · dimensions · duration · size). That's the
//     technical readout a media editor checks first; it grounds the tool in
//     its subject and is the single place we spend boldness.
//   * Everything else quiet: short, sentence-case, active voice, no filler,
//     no ALL-CAPS labels, no decorative arrows/emoji, no 01/02/03 markers
//     (the formats are a set, not a sequence).
//   * The 5 format buttons stay bare (the format name IS the label) but the
//     row is chunked 3-per-line so it's scannable on a phone.
//   * A format must be picked before the flow can move on: the "Continue"
//     button stays visible but the bot refuses to start until one is chosen,
//     and tells the user plainly to pick one.
//   * Conversion shows a live progress bar + a soft time estimate, not an
//     instant jump. Results only appear once every format has finished.
//   * Errors give direction, not mood.
//   * An action keeps the same name end-to-end: the button says "Continue"
//     and the result says "Converted".

const FORMAT_CHOICES = {
  image: ['PNG', 'JPEG', 'WEBP', 'GIF', 'AVIF'],
  video: ['MP4', 'WEBM', 'MOV', 'MKV', 'AVI'],
};

const MIME_BY_FORMAT = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  WEBP: 'image/webp',
  GIF: 'image/gif',
  AVIF: 'image/avif',
  MP4: 'video/mp4',
  WEBM: 'video/webm',
  MOV: 'video/quicktime',
  MKV: 'video/x-matroska',
  AVI: 'video/x-msvideo',
};

// Minimal Telegram-Markdown escaper for dynamic, user-controlled strings
// (filenames, spec lines). Static copy below is already safe.
function esc(s) {
  return String(s ?? '').replace(/([*_\[\]])/g, '\\$1');
}

function sizeLabel(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// The single memorable element. `spec` is the describeFile() line.
function idCard(name, spec) {
  let out = `**${esc(name)}**`;
  if (spec) out += `\n\`${esc(spec)}\``;
  return out;
}

// ---- messages -------------------------------------------------------------

// Intake: ID card leads, explicit instruction that a pick is required.
function intake(name, spec) {
  return `${idCard(name, spec)}\n\nPick one or more formats below. You can't continue until you pick at least one.`;
}

// Picking state: ID card persists, picks shown as a set.
function picked(name, spec, picks) {
  const list = picks.length ? picks.join(' · ') : 'nothing yet';
  const hint = picks.length
    ? `Tap Continue when ready.`
    : `Pick a format first — you can't continue without one.`;
  return `${idCard(name, spec)}\n\n*Picked:* ${list}\n\n${hint}`;
}

// Shown when the user taps Continue without picking anything.
function needsFormatPick() {
  return 'Pick a format first. Tap one of the options above, then Continue.';
}

// A soft total-time estimate in seconds. Rough, deliberately imprecise —
// video encodes run ~real-time on serverless, images are near-instant.
function estimateSeconds(fileBytes, nFormats, kind) {
  const mb = (fileBytes || 0) / 1048576;
  const per = kind === 'image'
    ? Math.min(12, 3 + mb * 0.5)   // images: a few seconds, grows mildly with size
    : Math.min(90, 8 + mb * 0.9);  // video: near real-time, grows with size
  return Math.max(10, Math.round(per * nFormats));
}

// A 16-cell text progress bar. `done`/`total` drive how many are filled.
function progress_bar(done, total) {
  const cells = 16;
  const fill = total ? Math.round((done / total) * cells) : 0;
  return '█'.repeat(Math.max(0, Math.min(cells, fill))) + '░'.repeat(cells - Math.max(0, Math.min(cells, fill)));
}

// Live progress message. `done`/`total` are finished/total formats;
// `elapsedSec` and `estSec` are real wall-clock and the soft estimate.
function convertingProgress(name, spec, picks, compress, done, total, elapsedSec, estSec) {
  const what = picks.join(', ');
  const mm = String(Math.floor(elapsedSec / 60));
  const ss = String(elapsedSec % 60).padStart(2, '0');
  const left = Math.max(0, estSec - elapsedSec);
  const leftStr = left <= 0 ? 'finishing up' : `≈ ${Math.ceil(left / 60)} min left`;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return [
    idCard(name, spec),
    '',
    `Converting to ${what}… ${compress ? 'Compressing. ' : ''}`,
    '',
    `\`${progress_bar(done, total)}\` ${done}/${total} done · ${pct}% · ${mm}:${ss} elapsed · ${leftStr}`,
  ].join('\n');
}

// The results message only appears after every format has finished (or failed).
function results(name, items, errors, elapsedSec) {
  let out = `Converted ${esc(name)}:\n`;
  for (const r of items) {
    const size = r.size ? sizeLabel(r.size) : '';
    out += `\n*${r.fmt}*\n${size}\n${r.url}`;
  }
  if (errors.length) {
    out += `\n\nDidn't convert:\n`;
    for (const e of errors) out += `*${e.fmt}* — ${esc(e.message)}\n`;
  }
  const mm = Math.floor(elapsedSec / 60), ss = elapsedSec % 60;
  out += `\n\nDone in ${mm}:${String(ss).padStart(2, '0')}. These files expire in 3 days.`;
  return out;
}

function tooBig(name, mb) {
  return `*${esc(name)}* is ${mb} MB — past the 50 MB I can pull from Telegram.\n` +
    `Send the public link instead and I'll fetch it from there.`;
}

function downloadFailed() {
  return "Couldn't read that file. Check the link still works, then try again.";
}

// The user supplied a URL that failed the SSRF host check.
function unsafeUrl() {
  return "I can't use that link — it points to a host I won't fetch from. Send a public media link instead.";
}

// The stored source reference could no longer be re-fetched (link expired,
// telegram file gone, or download failed mid-flow).
function sourceGone() {
  return "I lost the source file mid-conversion (links expire). Send it again and I'll start fresh.";
}

function noFormat() {
  return 'Pick a format first — tap one above, then Start.';
}

function cancelled() {
  return "Stopped. Send a file or link whenever you're ready to convert.";
}

// ---- keyboard -------------------------------------------------------------

// One row of up to 3 format buttons, then the "Continue" button (always
// visible — it just won't start until a format is picked), then the control
// row (compress toggle + cancel).
function keyboard(kind, session) {
  const formats = FORMAT_CHOICES[kind] || FORMAT_CHOICES.video;
  const picked = new Set(session.pendingFormats);
  const rows = [];
  for (let i = 0; i < formats.length; i += 3) {
    rows.push(
      formats.slice(i, i + 3).map((f) => ({
        text: picked.has(f) ? `${f} ✓` : f,
        callback_data: `fmt:${f}`,
      })),
    );
  }
  rows.push([{ text: 'Continue', callback_data: 'go' }]);
  rows.push([
    {
      text: session.compress ? 'Compress: on' : 'Compress: off',
      callback_data: 'compress:toggle',
    },
    { text: 'Cancel', callback_data: 'cancel' },
  ]);
  return { inline_keyboard: rows };
}

module.exports = {
  FORMAT_CHOICES,
  MIME_BY_FORMAT,
  keyboard,
  idCard,
  sizeLabel,
  intake,
  picked,
  needsFormatPick,
  estimateSeconds,
  progress_bar,
  convertingProgress,
  results,
  tooBig,
  downloadFailed,
  unsafeUrl,
  sourceGone,
  noFormat,
  cancelled,
};
