// src/storage-to.js
// Storage.to upload client.
//
// Exports:
//   async upload(localPath, opts) -> { url, id, expiresAt, filename, size }
//
// opts:
//   contentType  (required) mime type of the file
//   filename     (optional, defaults to basename of localPath)
//   visitor      (optional, overrides config STORAGE_TO_VISITOR)
//
// Flow:
//   Small files (<= 50MB):
//     POST /upload/init -> { upload_url, r2_key }
//     PUT bytes to upload_url (R2 presigned, no auth header)
//     POST /upload/confirm -> { success, file: { url, ... } }
//
//   Large files (> 50MB), multipart:
//     POST /upload/init -> { type:"multipart", upload_id, part_size,
//                            initial_urls: {partNumber: url}, owner_token,
//                            r2_key }
//     PUT each part to its URL, collect etags
//     POST /upload/complete-multipart { upload_id, parts: [{partNumber, etag}] }
//     POST /upload/confirm { filename, size, content_type, r2_key }

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const config = require('./config');

// 50 MB threshold: above this the init endpoint switches to multipart.
const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;

const CHUNK_READ_SIZE = 8 * 1024 * 1024; // stream large files in 8MB chunks to bound memory

function base() {
  return config.STORAGE_TO_BASE.replace(/\/+$/, '');
}

function authHeaders() {
  if (!config.STORAGE_TO_TOKEN) {
    throw new Error('STORAGE_TO_TOKEN is not configured (missing in /root/.hermes/secret.env or env)');
  }
  return {
    Authorization: `Bearer ${config.STORAGE_TO_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function postJson(url, body) {
  const res = await axios.post(url, body, { headers: authHeaders() });
  // non-2xx: axios already threw; here handle success:false payloads
  if (res.data && res.data.success === false) {
    throw new Error(`storage.to API error: ${res.data.error || JSON.stringify(res.data)}`);
  }
  if (!res.data) {
    throw new Error('storage.to API returned an empty response');
  }
  return res.data;
}

async function putBytesToUrl(uploadUrl, localPath, contentType, size, partOffset, partSize) {
  // R2 presigned PUT: no Authorization header, just Content-Type.
  // For small files send the whole buffer; for multipart parts, slice the file.
  const headers = { 'Content-Type': contentType };

  // Buffer upload (session-store blobs): send the buffer directly.
  if (Buffer.isBuffer(localPath)) {
    const res = await axios.put(uploadUrl, localPath, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res;
  }

  if (partSize != null) {
    // send Range-style body for a specific part: read [partOffset, partOffset+partSize)
    const buffer = await readRange(localPath, partOffset, partSize);
    const res = await axios.put(uploadUrl, buffer, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res;
  }

  if (size <= 16 * 1024 * 1024) {
    // Whole-file buffer is fine for small/medium files.
    const buffer = await fs.promises.readFile(localPath);
    const res = await axios.put(uploadUrl, buffer, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res;
  }

  // Stream large files to R2 to avoid loading them all in memory.
  const stream = fs.createReadStream(localPath, {
    start: partOffset || 0,
    end: (partOffset || 0) + partSize - 1,
  });
  const res = await axios.put(uploadUrl, stream, {
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res;
}

async function readRange(localPath, offset, size) {
  const buffer = Buffer.alloc(size);
  const handle = await fs.promises.open(localPath, 'r');
  try {
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read < size) throw new Error(`failed to read full range from ${localPath}`);
    return buffer;
  } finally {
    await handle.close();
  }
}

function splitParts(totalSize, partSize) {
  const count = Math.ceil(totalSize / partSize);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const start = i * partSize;
    const len = Math.min(partSize, totalSize - start);
    parts.push({ partNumber: i + 1, offset: start, size: len });
  }
  return parts;
}

async function uploadMultipart(localPath, fileName, contentType, size, init) {
  const { upload_id: uploadId, part_size: partSize, initial_urls: initialUrls, owner_token: ownerToken } = init;
  if (!uploadId || !partSize || !initialUrls || !ownerToken) {
    throw new Error(`storage.to multipart init missing fields: ${JSON.stringify(init)}`);
  }

  const parts = splitParts(size, partSize);
  const partResults = [];

  for (const p of parts) {
    const partUrl = initialUrls[String(p.partNumber)] || initialUrls[p.partNumber];
    if (!partUrl) {
      throw new Error(`storage.to multipart init did not provide URL for part ${p.partNumber}`);
    }
    let res;
    try {
      res = await putBytesToUrl(partUrl, localPath, contentType, p.size, p.offset, p.size);
    } catch (err) {
      throw new Error(`failed to upload part ${p.partNumber} to storage.to R2: ${err.message}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`part ${p.partNumber} upload returned non-2xx: ${res.status}`);
    }
    const etag =
      (res.headers && (res.headers['etag'] || res.headers['ETag'])) ||
      String(res.data && res.data.ETag ? res.data.ETag : '');
    if (!etag) {
      throw new Error(`part ${p.partNumber} response contained no ETag header`);
    }
    partResults.push({ partNumber: p.partNumber, etag });
  }

  const complete = await postJson(`${base()}/upload/complete-multipart`, {
    upload_id: uploadId,
    parts: partResults,
  });
  return { r2Key: complete.r2_key || init.r2_key };
}

/**
 * Upload a local file to storage.to and return the shareable URL + metadata.
 *
 * @param {string|Buffer} localPath absolute path to the file, or a Buffer.
 * @param {object} [opts]
 * @param {string} opts.contentType required mime type
 * @param {string} [opts.filename]  override for the stored filename
 * @param {string} [opts.visitor]   override for the storage.to visitor
 * @returns {Promise<{url: string, id: string|null, expiresAt: string|null, filename: string, size: number}>}
 */
async function upload(localPath, opts = {}) {
  const isBuffer = Buffer.isBuffer(localPath);
  if (!isBuffer && (!localPath || !path.isAbsolute(localPath))) {
    throw new Error('upload(): localPath must be an absolute path or a Buffer');
  }
  if (!opts.contentType) {
    throw new Error('upload(): opts.contentType is required');
  }

  const size = isBuffer ? localPath.length : (await fs.promises.stat(localPath)).size;
  const filename = opts.filename || (isBuffer ? 'data' : path.basename(localPath));
  const visitor = opts.visitor || config.STORAGE_TO_VISITOR;

  const initBody = { filename, content_type: opts.contentType, size };
  if (visitor) initBody.visitor = visitor;

  const init = await postJson(`${base()}/upload/init`, initBody);

  let r2Key;

  if (init.type === 'multipart') {
    if (size <= MULTIPART_THRESHOLD_BYTES) {
      // Server chose multipart even for a small file — honor it.
    }
    const result = await uploadMultipart(localPath, filename, opts.contentType, size, init);
    r2Key = result.r2Key;
  } else {
    const uploadUrl = init.upload_url;
    if (!uploadUrl || !init.r2_key) {
      throw new Error(`storage.to /upload/init did not return upload_url and r2_key: ${JSON.stringify(init)}`);
    }
    r2Key = init.r2_key;
    const res = await putBytesToUrl(uploadUrl, localPath, opts.contentType, size, 0, undefined);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`R2 PUT returned non-2xx: ${res.status}`);
    }
  }

  const confirmBody = { filename, size, content_type: opts.contentType, r2_key: r2Key };
  if (visitor) confirmBody.visitor = visitor;
  const confirmed = await postJson(`${base()}/upload/confirm`, confirmBody);

  const file = confirmed.file || confirmed;
  const url = file.url;
  if (!url) throw new Error('storage.to /upload/confirm did not return a file url');

  return {
    url,
    id: file.id ?? null,
    expiresAt: file.expires_at ?? null,
    filename,
    size,
  };
}

/**
 * Download the body of a Storage.to share URL, used to read back a
 * session blob persisted by the durable session store.
 *
 * @param {string} filenameOrUrl stored filename (e.g. "session-123") or full URL
 * @param {object} [opts]
 * @param {boolean} [opts.expectError] when true, a 404/410 resolves to null
 * @returns {Promise<string|null>} text body, or null if absent
 */
async function download(filenameOrUrl, opts = {}) {
  const target =
    /^https?:\/\//.test(filenameOrUrl)
      ? filenameOrUrl
      : `https://storage.to/${encodeURIComponent(filenameOrUrl)}`;
  let res;
  try {
    res = await axios.get(target, {
      responseType: 'text',
      maxContentLength: Infinity,
    });
  } catch (err) {
    if (opts.expectError && [404, 410].includes(err.response && err.response.status)) {
      return null;
    }
    throw new Error(`storage.to download failed: ${err.message}`);
  }
  if (res.status < 200 || res.status >= 300) {
    if (opts.expectError && [404, 410].includes(res.status)) return null;
    throw new Error(`storage.to download returned non-2xx: ${res.status}`);
  }
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
}

module.exports = { upload, download };
