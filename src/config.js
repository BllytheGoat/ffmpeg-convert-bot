// src/config.js
// Loads secrets from /root/.hermes/secret.env at boot.
// In Vercel, these values are set as environment variables instead.
const fs = require('fs');

const SECRET_ENV = '/root/.hermes/secret.env';

function loadSecretEnv(p = SECRET_ENV) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const secrets = loadSecretEnv();

// Prefer environment variables; fall back to the secret file.
function pick(key, fallback = '') {
  return process.env[key] || secrets[key] || fallback;
}

module.exports = {
  TELEGRAM_BOT_TOKEN: pick('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_WEBHOOK_SECRET: pick('TELEGRAM_WEBHOOK_SECRET'),
  STORAGE_TO_TOKEN: pick('STORAGE_TO_TOKEN'),
  // Durable session state. Vercel KV (Upstash Redis) is the production
  // backend: set REDIS_URL and the bot uses a real KV; otherwise it falls
  // back to in-memory (local dev / tests).
  REDIS_URL: pick('REDIS_URL'),
  STORAGE_TO_BASE: pick('STORAGE_TO_BASE', 'https://storage.to/api'),
  STORAGE_TO_VISITOR: pick('STORAGE_TO_VISITOR', 'hermes-ffmpeg-bot'),
  WEBHOOK_HOST: pick('WEBHOOK_HOST'), // e.g. https://ffmpeg-convert-bot.vercel.app
  WORKDIR: process.env.WORKDIR || '/tmp/ffmpeg-work',
  MAX_SOURCE_BYTES: 50 * 1024 * 1024, // 50 MB — Telegram bot getFile cap
};
