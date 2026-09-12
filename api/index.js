// api/index.js — Vercel Function: Telegram FFmpeg convert bot.
// Exposes GET / (health) and POST / (webhook) as a single-file Vercel function.
// Spine only: delegates heavy work to src/ffmpeg.js, src/storage-to.js,
// and the design layer src/ui.js (copy + keyboard).

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const { convert } = require('../src/ffmpeg');
const { upload } = require('../src/storage-to');
const { describeFile } = require('../src/meta');
const ui = require('../src/ui');
const config = require('../src/config');

// In-memory session state: chatId -> { sourcePath, kind, pendingFormats, compress, spec }
const sessions = new Map();

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
// Detect image vs video (MIME hint first, then extension)
// ---------------------------------------------------------------------------
function detectKind(filePath, mimeHint) {
  const mime = (mimeHint || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'tiff']);
  return imageExts.has(ext) ? 'image' : 'video';
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
    await processSource(chatId, { url, name: 'linked-file', mime: guessMimeFromUrl(url) });
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
  const name = msg.document?.file_name || (msg.video ? 'video' : 'image');
  const size = msg.document?.file_size || 0;

  if (size > config.MAX_SOURCE_BYTES) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: ui.tooBig(name, Math.round(size / 1048576)),
      parse_mode: 'Markdown',
    });
    return;
  }

  await processSource(chatId, { url: null, file_id, name, mime, size });
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
// Source processing: download -> detect -> build ID card -> show menu
// ---------------------------------------------------------------------------
async function processSource(chatId, sourceInfo) {
  const workdir = path.join(config.WORKDIR, String(chatId));
  fs.mkdirSync(workdir, { recursive: true });

  let srcPath;
  try {
    if (sourceInfo.url) {
      srcPath = path.join(workdir, sourceInfo.name || 'source');
      await httpDownload(sourceInfo.url, srcPath);
    } else if (sourceInfo.file_id) {
      const file = await tg('getFile', { file_id: sourceInfo.file_id });
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      srcPath = path.join(workdir, sourceInfo.name || 'source');
      await httpDownload(fileUrl, srcPath);
    } else {
      throw new Error('no source provided');
    }
  } catch (e) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: ui.downloadFailed(),
    });
    return;
  }

  const kind = detectKind(srcPath, sourceInfo.mime || '');
  const spec = await describeFile(srcPath, sourceInfo.mime || '');

  const session = {
    source: srcPath,
    kind,
    pendingFormats: [],
    compress: true, // default: compress on (recommended)
    mime: sourceInfo.mime,
    name: sourceInfo.name,
    spec,
  };
  sessions.set(chatId, session);

  await sendMenu(chatId, session);
}

// ---------------------------------------------------------------------------
// Callback handling
// ---------------------------------------------------------------------------
async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data || '';
  const session = sessions.get(chatId);
  if (!session) return;

  if (data === 'cancel') {
    sessions.delete(chatId);
    await tg('sendMessage', {
      chat_id: chatId,
      text: ui.cancelled(),
    });
    return;
  }

  if (data === 'compress:toggle') {
    session.compress = !session.compress;
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
      // The user pressed Continue without picking anything. Don't advance —
      // send a fresh nudge (a separate message, since the old one's keyboard
      // is already there) and keep the session alive.
      await tg('sendMessage', {
        chat_id: chatId,
        text: ui.needsFormatPick(),
      });
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
  const { source, pendingFormats, compress, name, spec } = session;
  const total = pendingFormats.length;
  const fileBytes = fs.existsSync(source) ? fs.statSync(source).size : 0;
  const estSec = ui.estimateSeconds(fileBytes, total, session.kind);
  const t0 = Date.now();

  // 1. Open the progress message at 0/total.
  const statusMsg = await tg('sendMessage', {
    chat_id: chatId,
    text: ui.convertingProgress(name, spec, pendingFormats, compress, 0, total, 0, estSec),
    parse_mode: 'Markdown',
  });

  // 2. Live ticker: refresh the bar every 2s with real elapsed time, so the
  //    user watches it fill instead of getting an instant jump.
  const timer = setInterval(async () => {
    try {
      const elapsed = Math.floor((Date.now() - t0) / 1000);
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: ui.convertingProgress(name, spec, pendingFormats, compress, done, total, elapsed, estSec),
        parse_mode: 'Markdown',
      });
    } catch (_) {
      /* transient edit failure — the final results edit below is authoritative */
    }
  }, 2000);

  const results = [];
  const errors = [];
  let done = 0;

  // 3. Convert + upload, advancing the bar after each format lands.
  for (const fmt of pendingFormats) {
    try {
      const outPath = await convert(source, fmt, compress);
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

  clearInterval(timer);
  sessions.delete(chatId);

  // 4. Results appear only after every format has finished (or failed).
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
