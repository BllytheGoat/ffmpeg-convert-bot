// index.js — Vercel Function: Telegram FFmpeg convert bot.
// Exposes GET / (health) and POST / (webhook) as a single-file Vercel function.
// Spine only: delegates heavy work to src/ffmpeg.js and src/storage-to.js.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const { convert } = require('./src/ffmpeg');
const { upload } = require('./src/storage-to');
const config = require('./src/config');

// In-memory session state: chatId -> { sourcePath, kind, pendingFormats, compress }
const sessions = new Map();

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
// Format menu (inline keyboard)
// ---------------------------------------------------------------------------
function buildFormatMenu(kind, session) {
  const formats = FORMAT_CHOICES[kind] || FORMAT_CHOICES.video;
  const rows = [
    // One button per format
    formats.map((f) => ({
      text: session.pendingFormats.includes(f) ? `✓ ${f}` : f,
      callback_data: `fmt:${f}`,
    })),
    // Compress toggle + action row
    [
      {
        text: session.compress ? '🗜  Compress: ON' : '🗜  Compress: OFF',
        callback_data: 'compress:toggle',
      },
      { text: '❌  Cancel', callback_data: 'cancel' },
    ],
  ];
  return rows;
}

async function sendFormatMenu(chatId, sourceInfo, kind) {
  const session = sessions.get(chatId);
  const formats = FORMAT_CHOICES[kind];
  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `Got ${sourceInfo.name} (${sourceInfo.mime}).\n` +
      `Tap the formats you want converted (up to 5), toggle compression, then start.`,
    reply_markup: {
      inline_keyboard: buildFormatMenu(kind, session),
    },
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
  const name = msg.document?.file_name || (msg.video ? 'video' : 'file');
  const size = msg.document?.file_size || 0;

  if (size > config.MAX_SOURCE_BYTES) {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `That file is ${Math.round(size / 1048576)} MB — over the 50 MB limit I can pull from Telegram. ` +
        `Send me the file's public URL instead and I'll download it from there.`,
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
// Source processing: download → detect → show menu
// ---------------------------------------------------------------------------
async function processSource(chatId, sourceInfo) {
  const workdir = path.join(config.WORKDIR, String(chatId));
  fs.mkdirSync(workdir, { recursive: true });

  let srcPath;
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

  const kind = detectKind(srcPath, sourceInfo.mime || '');

  sessions.set(chatId, {
    source: srcPath,
    kind,
    pendingFormats: [],
    compress: true, // default: compress on (recommended)
    mime: sourceInfo.mime,
    name: sourceInfo.name,
  });

  await sendFormatMenu(chatId, sourceInfo, kind);
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
      text: 'Cancelled. Send me another file or link when ready.',
    });
    return;
  }

  if (data === 'compress:toggle') {
    session.compress = !session.compress;
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cq.message.message_id,
      text: session.compress
        ? '🗜  Compression: ON — smaller files, minimal visible quality loss.'
        : 'Compression: OFF — lossless / high-bitrate, larger files.',
      reply_markup: {
        inline_keyboard: buildFormatMenu(session.kind, session),
      },
    });
    return;
  }

  if (data.startsWith('fmt:')) {
    const fmt = data.slice(4);
    if (!session.pendingFormats.includes(fmt)) {
      session.pendingFormats.push(fmt);
    }
    if (session.pendingFormats.length >= 5) {
      // All 5 picked — show "Start conversion" button
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text:
          `You picked: ${session.pendingFormats.join(', ')}\n` +
          `Tap start to convert, or unselect formats by tapping them again.`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: session.compress ? '▶  Start (compressed)' : '▶  Start (lossless)',
                callback_data: 'go',
              },
            ],
            buildFormatMenu(session.kind, session),
          ],
        },
      });
    } else {
      // Show current picks + remaining buttons
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text:
          `Picked: ${session.pendingFormats.join(', ')}\n` +
          `Pick up to 5, toggle compression, then start.`,
        reply_markup: {
          inline_keyboard: buildFormatMenu(session.kind, session),
        },
      });
    }
    return;
  }

  if (data === 'go') {
    if (session.pendingFormats.length === 0) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: 'Pick at least one format before starting.',
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
  const { source, pendingFormats, compress } = session;
  const statusMsg = await tg('sendMessage', {
    chat_id: chatId,
    text: `Converting to ${pendingFormats.join(', ')}… ${compress ? '(compressed)' : '(lossless)'}\nThis can take a minute.`,
  });

  const results = [];
  const errors = [];

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
      errors.push({ fmt, message: e.message.slice(0, 150) });
    }
  }

  sessions.delete(chatId);

  let text = `Done! Your ${results.length} file(s):\n`;
  for (const r of results) {
    text += `• ${r.fmt}: ${r.url}\n`;
  }
  if (errors.length) {
    text += `\n⚠️ ${errors.length} failed:\n`;
    for (const e of errors) text += `• ${e.fmt}: ${e.message}\n`;
  }
  text += `\nFiles expire in 3 days.`;

  await tg('editMessageText', {
    chat_id: chatId,
    message_id: statusMsg.message_id,
    text,
  }).catch(async () => {
    await tg('sendMessage', { chat_id: chatId, text });
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
