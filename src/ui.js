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
//   * Errors give direction, not mood.
//   * An action keeps the same name end-to-end: the button says "Start" and
//     the result says "Converted".

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

// Intake: ID card leads, one quiet instruction.
function intake(name, spec) {
  return `${idCard(name, spec)}\n\nTap a format to add it to the conversion.`;
}

// Picking state: ID card persists, picks shown as a set.
function picked(name, spec, picks) {
  const list = picks.length ? picks.join(' · ') : 'nothing yet';
  return `${idCard(name, spec)}\n\n*Picked:* ${list}`;
}

// Compress toggle — plain, names the tradeoff in the user's terms.
function compressNote(on) {
  return on
    ? 'Compress: on. Smaller files, little quality loss.'
    : 'Compress: off. Full quality, larger files.';
}

// In progress.
function converting(name, spec, picks, compress) {
  const what = picks.join(', ');
  return `${idCard(name, spec)}\n\nConverting to ${what}… ` +
    `${compress ? 'Compressing. ' : ''}This can take a minute for longer clips.`;
}

// Results: active word matches the button ("Converted").
function results(name, items, errors) {
  let out = `Converted ${esc(name)}:\n`;
  for (const r of items) {
    const size = r.size ? sizeLabel(r.size) : '';
    out += `\n*${r.fmt}*\n${size}\n${r.url}`;
  }
  if (errors.length) {
    out += `\n\nDidn't convert:\n`;
    for (const e of errors) out += `*${e.fmt}* — ${esc(e.message)}\n`;
  }
  out += `\n\nThese files expire in 3 days.`;
  return out;
}

function tooBig(name, mb) {
  return `*${esc(name)}* is ${mb} MB — past the 50 MB I can pull from Telegram.\n` +
    `Send the public link instead and I'll fetch it from there.`;
}

function downloadFailed() {
  return "Couldn't read that file. Check the link still works, then try again.";
}

function noFormat() {
  return 'Pick a format first — tap one above, then Start.';
}

function cancelled() {
  return "Stopped. Send a file or link whenever you're ready to convert.";
}

// ---- keyboard -------------------------------------------------------------

// One row of up to 3 format buttons, then Start (when ≥1 picked), then the
// control row (compress toggle + cancel).
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
  if (picked.size >= 1) rows.push([{ text: 'Start', callback_data: 'go' }]);
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
  compressNote,
  converting,
  results,
  tooBig,
  downloadFailed,
  noFormat,
  cancelled,
};
