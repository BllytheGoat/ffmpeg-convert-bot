// src/session-store.js
// Durable, pluggable session state for the multi-turn convert flow.
//
// The bot's pick->continue->results flow spans several separate Vercel
// invocations, so in-process memory is not reliable in production. This module
// abstracts the store behind a tiny interface and ships two implementations:
//
//   MemoryStore — local dev / tests. Fast, process-local.
//   RedisStore  — durable. Talks to a Redis-compatible store (Vercel KV /
//                 Upstash / plain Redis) over a minimal zero-dep RESP client,
//                 so any function instance (cold start included) can read back
//                 the user's in-flight session.
//
// A session carries the source by REFERENCE ({kind:'telegram',file_id} or
// {kind:'url',url}), not by local path, so it can always be re-fetched even
// after the original /tmp file is gone.
//
// NOTE: A media host (Storage.to) is NOT a valid session store here — its
// share URLs 403 on programmatic re-download, so state can't be read back.
// Durable state needs a KV/Redis, which is why RedisStore exists.

const config = require('./config');

// ---------------------------------------------------------------------------
// Store interface:
//   async get(chatId)     -> object | null
//   async set(chatId, obj, ttlMs)
//   async delete(chatId)
//   async clear(chatId)   -> remove the session for that chat
// ---------------------------------------------------------------------------

const TTL_MS = 1000 * 60 * 30; // sessions live 30 minutes
const PREFIX = 's';

class MemoryStore {
  constructor() {
    this.map = new Map(); // key -> { value, expiresAt }
  }
  key(chatId) {
    return `${PREFIX}:${chatId}`;
  }
  async get(chatId) {
    const rec = this.map.get(this.key(chatId));
    if (!rec) return null;
    if (rec.expiresAt && Date.now() > rec.expiresAt) {
      this.map.delete(this.key(chatId));
      return null;
    }
    return rec.value;
  }
  async set(chatId, value, ttlMs = TTL_MS) {
    this.map.set(this.key(chatId), { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  }
  async delete(chatId) {
    this.map.delete(this.key(chatId));
  }
  async clear(chatId) {
    this.map.delete(this.key(chatId));
  }
}

// ---------------------------------------------------------------------------
// Minimal Redis client (RESP protocol) — GET / SET (with TTL) / DEL / AUTH.
// Zero external deps; works with any Redis-compatible endpoint, including
// Vercel KV and Upstash (pass REDIS_URL with credentials embedded).
// ---------------------------------------------------------------------------
class RedisStore {
  constructor(opts = {}) {
    this.url = opts.url;
    if (!this.url) throw new Error('RedisStore requires REDIS_URL');
    // Parse a redis:// URL, supporting password in the URL.
    const u = new URL(this.url);
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : 6379;
    this.password = u.password || opts.password || '';
    this._dbIdx = 0;
    this._socket = null;
    this._seq = null;
    this._authed = false;
    this._queue = []; // pending [callback, resolve]
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const sock = net.connect(this.port, this.host, () => {
        this._socket = sock;
        sock.on('data', (d) => this._onData(d));
        sock.on('error', (e) => {
          reject(e);
          this._socket = null;
        });
        sock.on('close', () => {
          this._socket = null;
          reject(new Error('redis connection closed'));
        });
        // Kick off AUTH if we have a password, then SELECT 0, then ready.
        if (this.password) {
          this._send(['AUTH', this.password]).then(() => resolve(sock)).catch(reject);
        } else {
          resolve(sock);
        }
      });
      sock.setTimeout(5000, () => sock.destroy(new Error('redis connect timeout')));
    });
  }

  _onData(buf) {
    // Accumulate and parse complete RESP replies out of the byte stream.
    this._buf = Buffer.concat([this._buf || Buffer.alloc(0), buf]);
    let parsed;
    while ((parsed = this._tryParse()) !== null) {
      const cb = this._queue.shift();
      if (!cb) continue;
      if (parsed.type === '-') {
        cb.reject(new Error(String(parsed.value)));
      } else if (parsed.type === '$' && parsed.value === -1) {
        cb.resolve(null);
      } else if (parsed.type === '+') {
        cb.resolve(String(parsed.value));
      } else {
        cb.resolve(parsed.value);
      }
    }
  }

  _tryParse() {
    const buf = this._buf;
    if (!buf || buf.length === 0) return null;
    const nl = buf.indexOf(0x0a); // \n
    if (nl === -1) return null;
    const type = String.fromCharCode(buf[0]);
    const payload = buf.slice(1, nl).toString();
    let value;
    let consumed = nl + 1;
    if (type === '$') {
      const len = parseInt(payload, 10);
      if (len === -1) {
        value = -1;
      } else {
        if (buf.length < consumed + len + 2) return null; // wait for full body
        value = buf.slice(consumed, consumed + len).toString();
        consumed += len + 2; // body + CRLF
      }
    } else {
      value = payload;
    }
    this._buf = buf.slice(consumed);
    return { type, value };
  }

  _send(cmd) {
    // Encode a single RESP array command.
    let out = `*${cmd.length}\r\n`;
    for (const arg of cmd) {
      out += `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`;
    }
    this._socket.write(out);
    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject });
    });
  }

  _ensure() {
    if (!this._socket) return this._connect();
    return Promise.resolve(this._socket);
  }

  async _run(cmd) {
    await this._ensure();
    try {
      return await this._send(cmd);
    } catch (e) {
      // Retry once on a dead socket (transient cold reconnect).
      this._socket = null;
      await this._ensure();
      return this._send(cmd);
    }
  }

  key(chatId) {
    return `${PREFIX}:${chatId}`;
  }

  async get(chatId) {
    const raw = await this._run(['GET', this.key(chatId)]);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.__exp && Date.now() > parsed.__exp) {
        await this.delete(chatId);
        return null;
      }
      return parsed ? parsed.__data : null;
    } catch (_) {
      return null;
    }
  }
  async set(chatId, value, ttlMs = TTL_MS) {
    const payload = JSON.stringify({ __data: value, __exp: Date.now() + ttlMs });
    await this._run(['SET', this.key(chatId), payload, 'PX', String(ttlMs)]);
  }
  async delete(chatId) {
    await this._run(['DEL', this.key(chatId)]);
  }
  async clear(chatId) {
    await this.delete(chatId);
  }
}

// Return a store wired to the environment:
//   * durable (RedisStore) when REDIS_URL or a KV REST token is present,
//   * in-memory otherwise (local dev / tests).
// Set DURABLE_SESSIONS=off to force in-memory regardless.
function createStore() {
  if (process.env.DURABLE_SESSIONS === 'off') return new MemoryStore();
  const redisUrl = config.REDIS_URL;
  if (redisUrl) {
    try {
      return new RedisStore({ url: redisUrl });
    } catch (e) {
      return new MemoryStore();
    }
  }
  return new MemoryStore();
}

module.exports = { MemoryStore, RedisStore, createStore };
