// api/index.js — Vercel Function: Telegram FFmpeg convert bot.
// Exposes GET / (health) and POST / (webhook) as a single-file Vercel function.
// Spine only: delegates heavy work to src/ffmpeg.js, src/storage-to.js,
// src/session-store.js (durable state), and the design layer src/ui.js.
//
// Hardening:
//   * Session state is durable (Storage.to-backed) so the pick->continue flow
//     survives Vercel cold starts between invocations.
//   * The webhook verifies X-Telegram-Bot-Api-Secret-Token when configured.
//   * User-supplied URLs are scheme/host-checked (SSRF guard); filenames are
//     never used to build file paths (the source is always materialized to
//     <workdir>/source).

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');

const { convert } = require('../src/ffmpeg');
const { upload } = require('../src/storage-to');
const { describeFile } = require('../src/meta');
const { createStore } = require('../src/session-store');
const ui = require('../src/ui');
const config = require('../src/config');

// Durable session store: Storage.to-backed when creds are present, in-memory
// otherwise (local dev / tests). Replaceable for tests via setStore().
let store = createStore();
function setStore(s) {
  store = s;
}
function getStore() {
  return store;
}

const { FORMAT_CHOICES, MIME_BY_FORMAT } = ui;

// ---------------------------------------------------------------------------
// Telegram API helper (raw HTTPS, zero deps)
// ---------------------------------------------------------------------------
function tg(method, body) {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('TELEGRAM_BOT_TOKEN not set'));
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) reject(new Error(`Telegram ${method}: ${json.description}`));
          else resolve(json.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP download helper
// ---------------------------------------------------------------------------
function httpDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(dest);
    mod
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`download failed: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', (e) => reject(e));
  });
}

// ---------------------------------------------------------------------------
// Input hardening
// ---------------------------------------------------------------------------

// Keep only a safe display name from a user-supplied filename; never feed it
// to path.join. Allows letters, digits, hyphens, underscores, dots.
function safeName(raw) {
  const base = path.basename(String(raw || 'file'));
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
  return clean || 'file';
}

// SSRF guard: allow only http/https on public, non-internal hosts.
function isSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.toLowerCase();
  // Reject common internal / reserved hosts by label.
  const badHost =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal');
  if (badHost) return false;

  // Reject private/loopback/reserved IPv4 literal hosts.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const oct = host.split('.').map(Number);
    const [a, b] = oct;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }

  // IPv6 literal: reject loopback and link-local prefixes.
  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) {
      return false;
    }
    return true;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Detect image vs video — single source of truth in src/ffmpeg.js
// ---------------------------------------------------------------------------
// detectKind is imported from src/ffmpeg (ffprobe-aware) and exposed here so
// tests and callers have one implementation.
const { detectKind } = require('../src/ffmpeg');

// ---------------------------------------------------------------------------
// Materialize a source reference into a local path (re-fetchable across
// instances — the source is stored by reference, not by local path).
// ---------------------------------------------------------------------------
async function materializeSource(chatId, sourceRef) {
  const workdir = path.join(config.WORKDIR, String(chatId));
  fs.mkdirSync(workdir, { recursive: true });
  const dest = path.join(workdir, 'source');
  if (sourceRef && sourceRef.kind === 'url') {
    if (!isSafeUrl(sourceRef.url)) throw new Error('unsafe source URL');
    await httpDownload(sourceRef.url, dest);
  } else if (sourceRef && sourceRef.kind === 'telegram') {
    const file = await tg('getFile', { file_id: sourceRef.file_id });
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    await httpDownload(fileUrl, dest);
  } else {
    throw new Error('no valid source reference');
  }
  return dest;
}

// ---------------------------------------------------------------------------
// Menu presentation (design lives in src/ui.js)
// ---------------------------------------------------------------------------
async function sendMenu(chatId, session) {
  const text = session.pendingFormats.length
    ? ui.picked(session.name, session.spec, session.pendingFormats)
    : ui.intake(session.name, session.spec);
  await tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: ui.keyboard(session.kind, session),
  });
}

// ---------------------------------------------------------------------------
// Incoming message handler
// ---------------------------------------------------------------------------
async function handleIncomingMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;

  // URL as source
  if (msg.text && /^https?:\/\//.test(msg.text.trim())) {
    const url = msg.text.trim();
    if (!isSafeUrl(url)) {
      await tg('sendMessage', { chat_id: chatId, text: ui.unsafeUrl() });
      return;
    }
    const sourceRef = { kind: 'url', url };
    await processSource(chatId, { sourceRef, name: 'linked-file', mime: guessMimeFromUrl(url) });
    return;
  }

  // Dropped file
  const filePart = msg.video || msg.document || msg.photo;
  if (!filePart) return;

  let fileObj;
  if (msg.photo) {
    fileObj = msg.photo[msg.photo.length - 1]; // largest size
  } else {
    fileObj = filePart;
  }
  const file_id = fileObj.file_id;
  if (!file_id) return;

  const mime = msg.video?.mime_type || msg.document?.mime_type || 'image/jpeg';
  const name = safeName(msg.document?.file_name || (msg.video ? 'video' : 'image'));
  const size = msg.document?.file_size || 0;

  if (size > config.MAX_SOURCE_BYTES) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: ui.tooBig(name, Math.round(size / 1048576)),
      parse_mode: 'Markdown',
    });
    return;
  }

  const sourceRef = { kind: 'telegram', file_id };
  await processSource(chatId, { sourceRef, name, mime, size });
}

function guessMimeFromUrl(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  const map = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/avi',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
  };
  return map[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Source processing: materialize -> detect -> build ID card -> store session
// ---------------------------------------------------------------------------
async function processSource(chatId, { sourceRef, name, mime, size }) {
  let srcPath;
  try {
    srcPath = await materializeSource(chatId, sourceRef);
  } catch (e) {
    await tg('sendMessage', { chat_id: chatId, text: ui.downloadFailed() });
    return;
  }

  const kind = await detectKind(srcPath, mime || '');
  const spec = await describeFile(srcPath, mime || '');

  const session = {
    sourceRef,
    kind,
    pendingFormats: [],
    compress: true, // default: compress on (recommended)
    mime: mime,
    name,
    spec,
  };
  await store.set(chatId, session);

  await sendMenu(chatId, session);
}

// ---------------------------------------------------------------------------
// Callback handling (stateless — full session lives in the durable store)
// ---------------------------------------------------------------------------
async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data || '';
  const session = await store.get(chatId);
  if (!session) return; // expired / unknown session -> nothing to act on

  if (data === 'cancel') {
    await store.delete(chatId);
    await tg('sendMessage', { chat_id: chatId, text: ui.cancelled() });
    return;
  }

  if (data === 'compress:toggle') {
    session.compress = !session.compress;
    await store.set(chatId, session);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cq.message.message_id,
      text: ui.picked(session.name, session.spec, session.pendingFormats),
      parse_mode: 'Markdown',
      reply_markup: ui.keyboard(session.kind, session),
    });
    return;
  }

  if (data.startsWith('fmt:')) {
    const fmt = data.slice(4);
    if (!session.pendingFormats.includes(fmt)) {
      session.pendingFormats.push(fmt);
    }
    await store.set(chatId, session);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cq.message.message_id,
      text: ui.picked(session.name, session.spec, session.pendingFormats),
      parse_mode: 'Markdown',
      reply_markup: ui.keyboard(session.kind, session),
    });
    return;
  }

  if (data === 'go') {
    if (session.pendingFormats.length === 0) {
      await tg('sendMessage', { chat_id: chatId, text: ui.needsFormatPick() });
      return;
    }
    await startConversion(chatId, session);
    return;
  }
}

// ---------------------------------------------------------------------------
// Conversion + upload + reply
// ---------------------------------------------------------------------------
async function startConversion(chatId, session) {
  const { sourceRef, pendingFormats, compress, name, spec } = session;
  const total = pendingFormats.length;

  // Open the progress message, then re-fetch the source fresh (its local
  // copy may be gone on a cold start — sourceRef is authoritative).
  const statusMsg = await tg('sendMessage', {
    chat_id: chatId,
    text: ui.convertingProgress(name, spec, pendingFormats, compress, 0, total, 0, 0),
    parse_mode: 'Markdown',
  });

  let srcPath;
  try {
    srcPath = await materializeSource(chatId, sourceRef);
  } catch (e) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: ui.sourceGone(),
    }).catch(() => {});
    await store.delete(chatId);
    return;
  }

  const fileBytes = fs.existsSync(srcPath) ? fs.statSync(srcPath).size : 0;
  const estSec = ui.estimateSeconds(fileBytes, total, session.kind);
  const t0 = Date.now();

  const results = [];
  const errors = [];
  let done = 0;

  for (const fmt of pendingFormats) {
    try {
      const outPath = await convert(srcPath, fmt, compress);
      const mime = MIME_BY_FORMAT[fmt] || 'application/octet-stream';
      const st = await upload(outPath, {
        contentType: mime,
        filename: path.basename(outPath),
      });
      results.push({ fmt, url: st.url, id: st.id, expiresAt: st.expiresAt, size: st.size });
    } catch (e) {
      errors.push({ fmt, message: e.message.split('\n')[0].slice(0, 120) });
    }
    done += 1;
    const elapsed = Math.floor((Date.now() - t0) / 1000);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: ui.convertingProgress(name, spec, pendingFormats, compress, done, total, elapsed, estSec),
      parse_mode: 'Markdown',
    }).catch(() => {});
  }

  await store.delete(chatId);

  const elapsed = Math.floor((Date.now() - t0) / 1000);
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: statusMsg.message_id,
    text: ui.results(name, results, errors, elapsed),
    parse_mode: 'Markdown',
  }).catch(async () => {
    await tg('sendMessage', { chat_id: chatId, text: ui.results(name, results, errors, elapsed), parse_mode: 'Markdown' });
  });
}

// ---------------------------------------------------------------------------
// Webhook secret verification
// ---------------------------------------------------------------------------
function webhookAuthorized(req) {
  const secret = config.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured -> open (dev)
  const provided = req.headers['x-telegram-bot-api-secret-token'] || '';
  return provided === secret;
}

// ---------------------------------------------------------------------------
// Vercel Function entry point
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, service: 'ffmpeg-convert-bot' }));
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (!webhookAuthorized(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  let body;
  try {
    if (typeof req.body === 'string') body = JSON.parse(req.body);
    else body = req.body || {};
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  // Handle callback queries (inline keyboard presses)
  if (body.callback_query) {
    await handleCallback(body.callback_query);
    await tg('answerCallbackQuery', {
      callback_query_id: body.callback_query.id,
    }).catch(() => {});
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Handle incoming messages
  const msg = body.message || body.edited_message;
  if (msg) {
    await handleIncomingMessage(msg);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, ignored: true }));
};

module.exports.setStore = setStore;
module.exports.getStore = getStore;
module.exports.isSafeUrl = isSafeUrl;
module.exports.safeName = safeName;
module.exports.detectKind = detectKind;
