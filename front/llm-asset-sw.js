const cacheRules = new Map();
const SW_VERSION = '2026-04-15-cache-prefetch-v3';
const PROGRESS_REPORT_CHUNK_BYTES = 1024 * 1024;
const MAX_SMALL_HASH_BYTES = 64 * 1024 * 1024;
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function normalizePathPrefixes(prefixes) {
  return Array.isArray(prefixes)
    ? prefixes.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function normalizeUrls(urls) {
  return Array.isArray(urls)
    ? urls.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function buildRequest(url) {
  return new Request(url, {
    method: 'GET',
    credentials: 'same-origin',
  });
}

function getObservedSizeBytes(response) {
  const headerValue = response?.headers?.get?.('content-length');
  if (headerValue === null || headerValue === undefined || headerValue === '') {
    return null;
  }
  const parsed = Number(headerValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeSha256Hex(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : '';
}

function normalizeExpectedAssets(expectedAssets) {
  if (!Array.isArray(expectedAssets)) {
    return [];
  }

  const normalized = [];
  for (const item of expectedAssets) {
    const rawUrl = String(item?.url ?? '').trim();
    if (!rawUrl) {
      continue;
    }

    normalized.push({
      url: new URL(rawUrl, self.location.href).href,
      sha256: normalizeSha256Hex(item?.sha256),
      sizeBytes: Number.isFinite(item?.sizeBytes) ? Math.max(0, Number(item.sizeBytes)) : null,
    });
  }

  return normalized;
}

function buildExpectedAssetMap(expectedAssets) {
  return new Map(
    normalizeExpectedAssets(expectedAssets).map((item) => [item.url, item]),
  );
}

class Sha256Stream {
  constructor() {
    this.state = new Uint32Array([
      0x6a09e667,
      0xbb67ae85,
      0x3c6ef372,
      0xa54ff53a,
      0x510e527f,
      0x9b05688c,
      0x1f83d9ab,
      0x5be0cd19,
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.totalBytes = 0n;
    this.words = new Uint32Array(64);
  }

  update(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.totalBytes += BigInt(data.length);

    let offset = 0;
    while (offset < data.length) {
      const toCopy = Math.min(64 - this.bufferLength, data.length - offset);
      this.buffer.set(data.subarray(offset, offset + toCopy), this.bufferLength);
      this.bufferLength += toCopy;
      offset += toCopy;

      if (this.bufferLength === 64) {
        this.processBlock(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  processBlock(block) {
    const words = this.words;
    for (let i = 0; i < 16; i += 1) {
      const offset = i * 4;
      words[i] = (
        (block[offset] << 24)
        | (block[offset + 1] << 16)
        | (block[offset + 2] << 8)
        | block[offset + 3]
      ) >>> 0;
    }

    for (let i = 16; i < 64; i += 1) {
      const w15 = words[i - 15];
      const w2 = words[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      words[i] = (((words[i - 16] + s0) >>> 0) + ((words[i - 7] + s1) >>> 0)) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (((((h + S1) >>> 0) + ch) >>> 0) + ((SHA256_K[i] + words[i]) >>> 0)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digestHex() {
    this.buffer[this.bufferLength] = 0x80;
    this.bufferLength += 1;

    if (this.bufferLength > 56) {
      while (this.bufferLength < 64) {
        this.buffer[this.bufferLength] = 0;
        this.bufferLength += 1;
      }
      this.processBlock(this.buffer);
      this.bufferLength = 0;
    }

    while (this.bufferLength < 56) {
      this.buffer[this.bufferLength] = 0;
      this.bufferLength += 1;
    }

    const totalBits = this.totalBytes * 8n;
    for (let i = 0; i < 8; i += 1) {
      const shift = BigInt((7 - i) * 8);
      this.buffer[56 + i] = Number((totalBits >> shift) & 0xffn);
    }
    this.processBlock(this.buffer);

    const digest = new Uint8Array(32);
    for (let i = 0; i < 8; i += 1) {
      digest[i * 4] = this.state[i] >>> 24;
      digest[i * 4 + 1] = (this.state[i] >>> 16) & 0xff;
      digest[i * 4 + 2] = (this.state[i] >>> 8) & 0xff;
      digest[i * 4 + 3] = this.state[i] & 0xff;
    }
    return bytesToHex(digest);
  }
}

async function getObservedIntegrity(response, observedSizeBytes) {
  if (!response?.clone) {
    return {
      observedSha256: '',
      verificationMethod: '',
    };
  }

  const cloned = response.clone();
  if (cloned.body?.getReader) {
    const reader = cloned.body.getReader();
    const hasher = new Sha256Stream();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hasher.update(value);
    }
    return {
      observedSha256: hasher.digestHex(),
      verificationMethod: 'stream-sha256',
    };
  }

  if (!cloned.arrayBuffer || (observedSizeBytes !== null && observedSizeBytes > MAX_SMALL_HASH_BYTES)) {
    return {
      observedSha256: '',
      verificationMethod: '',
    };
  }

  const buffer = await cloned.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return {
    observedSha256: bytesToHex(new Uint8Array(digest)),
    verificationMethod: 'subtle-digest',
  };
}

async function buildAssetReport(url, response, source, enableHash = true, expectedSha256 = '') {
  const observedSizeBytes = getObservedSizeBytes(response);
  const expectedHash = enableHash ? normalizeSha256Hex(expectedSha256) : '';
  const {
    observedSha256,
    verificationMethod,
  } = enableHash
    ? await getObservedIntegrity(response, observedSizeBytes)
    : { observedSha256: '', verificationMethod: '' };
  return {
    url,
    source,
    observedSizeBytes,
    observedSha256,
    integrityVerified: Boolean(expectedHash && observedSha256 && expectedHash === observedSha256),
    verificationMethod,
    contentType: response?.headers?.get?.('content-type') || '',
    etag: response?.headers?.get?.('etag') || '',
    lastModified: response?.headers?.get?.('last-modified') || '',
  };
}

function assetReportHasMismatch(assetReport, expectedAsset) {
  const expectedHash = normalizeSha256Hex(expectedAsset?.sha256);
  const expectedSizeBytes = Number.isFinite(expectedAsset?.sizeBytes) ? Math.max(0, Number(expectedAsset.sizeBytes)) : null;
  const hashMismatch = Boolean(expectedHash && assetReport?.observedSha256 && assetReport.observedSha256 !== expectedHash);
  const sizeMismatch = expectedSizeBytes !== null
    && typeof assetReport?.observedSizeBytes === 'number'
    && assetReport.observedSizeBytes !== expectedSizeBytes;

  return hashMismatch || sizeMismatch;
}

async function streamNetworkResponseToCache({
  cache,
  request,
  response,
  url,
  progressPort,
  enableHash,
  expectedSha256 = '',
}) {
  const observedSizeBytes = getObservedSizeBytes(response);
  const headers = new Headers(response.headers);
  const reader = response.body.getReader();
  const normalizedExpectedSha256 = enableHash ? normalizeSha256Hex(expectedSha256) : '';
  const hasher = enableHash ? new Sha256Stream() : null;
  const transform = new TransformStream();
  const writer = transform.writable.getWriter();
  const cachePutPromise = cache.put(request, new Response(transform.readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));

  let downloadedBytes = 0;
  let reportedBytes = 0;
  progressPort?.postMessage({
    kind: 'progress',
    url,
    downloadedBytes: 0,
    totalBytes: observedSizeBytes,
    source: 'service-worker-network',
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      downloadedBytes += value.byteLength;
      hasher?.update(value);
      await writer.write(value);

      if (downloadedBytes - reportedBytes >= PROGRESS_REPORT_CHUNK_BYTES) {
        reportedBytes = downloadedBytes;
        progressPort?.postMessage({
          kind: 'progress',
          url,
          downloadedBytes,
          totalBytes: observedSizeBytes,
          source: 'service-worker-network',
        });
      }
    }

    await writer.close();
    await cachePutPromise;
  } catch (error) {
    await writer.abort(error).catch(() => {});
    throw error;
  }

  progressPort?.postMessage({
    kind: 'progress',
    url,
    downloadedBytes,
    totalBytes: observedSizeBytes,
    source: 'service-worker-network',
    done: true,
  });

  const observedSha256 = hasher ? hasher.digestHex() : '';

  return {
    url,
    source: 'service-worker-network',
    observedSizeBytes: downloadedBytes || observedSizeBytes,
    observedSha256,
    integrityVerified: Boolean(normalizedExpectedSha256 && observedSha256 && observedSha256 === normalizedExpectedSha256),
    verificationMethod: hasher ? 'stream-sha256' : '',
    contentType: response.headers.get('content-type') || '',
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

async function prefetchUrls(cacheName, urls, progressPort = null, enableHash = true, expectedAssets = []) {
  const normalizedUrls = Array.isArray(urls)
    ? urls.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];

  if (normalizedUrls.length === 0) {
    return [];
  }

  const cache = await caches.open(cacheName);
  const cachedUrls = [];
  const assetReports = [];
  const expectedAssetMap = buildExpectedAssetMap(expectedAssets);

  for (const url of normalizedUrls) {
    const cacheRequest = buildRequest(url);
    const expectedAsset = expectedAssetMap.get(url) || null;
    const cachedResponse = await cache.match(cacheRequest, { ignoreVary: true });
    if (cachedResponse) {
      const cachedAssetReport = await buildAssetReport(
        url,
        cachedResponse,
        'service-worker-cache',
        enableHash,
        expectedAsset?.sha256 || '',
      );
      if (assetReportHasMismatch(cachedAssetReport, expectedAsset)) {
        await cache.delete(cacheRequest);
      } else {
        cachedUrls.push(url);
        assetReports.push(cachedAssetReport);
        continue;
      }
    }

    const response = await fetch(cacheRequest);
    if (!response.ok) {
      throw new Error(`ASSET_PREFETCH_FAILED:${response.status}:${url}`);
    }
    const shouldStream = Boolean(response.body);

    if (!shouldStream) {
      await cache.put(cacheRequest, response.clone());
      const assetReport = await buildAssetReport(
        url,
        response,
        'service-worker-network',
        enableHash,
        expectedAsset?.sha256 || '',
      );
      if (assetReportHasMismatch(assetReport, expectedAsset)) {
        await cache.delete(cacheRequest);
      } else {
        cachedUrls.push(url);
      }
      assetReports.push(assetReport);
      continue;
    }

    const assetReport = await streamNetworkResponseToCache({
      cache,
      request: cacheRequest,
      response,
      url,
      progressPort,
      enableHash,
      expectedSha256: expectedAsset?.sha256 || '',
    });
    if (assetReportHasMismatch(assetReport, expectedAsset)) {
      await cache.delete(cacheRequest);
    } else {
      cachedUrls.push(url);
    }
    assetReports.push(assetReport);
  }

  return {
    cachedUrls,
    assetReports,
  };
}

function shouldHandleRequest(url) {
  if (url.origin !== self.location.origin) {
    return null;
  }

  for (const [cacheName, rule] of cacheRules.entries()) {
    if (rule.includeUrls.has(url.href)) {
      return cacheName;
    }

    if (rule.includePathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      return cacheName;
    }
  }

  return null;
}

async function getCachedResponse(request, cacheName) {
  const cache = await caches.open(cacheName);
  return cache.match(buildRequest(request.url), { ignoreVary: true });
}

async function cacheResponse(request, response, cacheName) {
  if (!response.ok) {
    return;
  }

  try {
    const cache = await caches.open(cacheName);
    await cache.put(buildRequest(request.url), response.clone());
  } catch (error) {
    console.warn('llm-asset-sw cache.put failed', request.url, error);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith('llm-assets::'))
        .map((cacheName) => {
          if (!cacheName.includes('::v1')) {
            return caches.delete(cacheName);
          }
          return Promise.resolve(false);
        }),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const message = event.data || {};
  const port = event.ports?.[0];

  if (message.type === 'configure_asset_cache') {
    const cacheName = String(message.cacheName ?? '').trim();
    if (cacheName) {
      cacheRules.set(cacheName, {
        includePathPrefixes: normalizePathPrefixes(message.includePathPrefixes),
        includeUrls: new Set(normalizeUrls(message.includeUrls)),
      });
    }
    port?.postMessage({ ok: true, cacheName, version: SW_VERSION });
    return;
  }

  if (message.type === 'prefetch_asset_urls') {
    const cacheName = String(message.cacheName ?? '').trim();
    const urls = normalizeUrls(message.urls);
    const expectedAssets = normalizeExpectedAssets(message.expectedAssets);
    const enableHash = message.enableHash !== false;
    event.waitUntil((async () => {
      try {
        const result = await prefetchUrls(cacheName, urls, port, enableHash, expectedAssets);
        port?.postMessage({
          ok: true,
          cacheName,
          cachedUrls: result.cachedUrls,
          assetReports: result.assetReports,
          version: SW_VERSION,
        });
      } catch (error) {
        port?.postMessage({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          cacheName,
          version: SW_VERSION,
        });
      }
    })());
    return;
  }

  port?.postMessage({ ok: false, reason: 'UNKNOWN_MESSAGE_TYPE' });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  const cacheName = shouldHandleRequest(url);
  if (!cacheName) {
    return;
  }

  event.respondWith((async () => {
    const cachedResponse = await getCachedResponse(request, cacheName);
    if (cachedResponse) {
      return cachedResponse;
    }

    const response = await fetch(request);
    event.waitUntil(cacheResponse(request, response, cacheName));
    return response;
  })());
});
