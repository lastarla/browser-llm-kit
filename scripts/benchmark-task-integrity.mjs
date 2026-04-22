import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DEFAULT_FILE = path.resolve('examples/meeting-notes-demo/web/assets/llm/gemma-4-E2B-it-web.task');
const CHUNK_SIZE = 1024 * 1024;
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
    return Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}

async function benchmarkMode(filePath, mode) {
  const hasher = mode === 'js-stream'
    ? new Sha256Stream()
    : mode === 'native-stream'
      ? createHash('sha256')
      : null;
  const startedAt = process.hrtime.bigint();
  let bytes = 0;

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hasher?.update(chunk);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    mode,
    bytes,
    durationMs,
    throughputMBps: Number((bytes / 1024 / 1024) / (durationMs / 1000)).toFixed(2),
    sha256: mode === 'js-stream'
      ? hasher.digestHex()
      : mode === 'native-stream'
        ? hasher.digest('hex')
        : '',
  };
}

async function main() {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;
  const fileStat = await stat(filePath);

  const sizeOnly = await benchmarkMode(filePath, 'size-only');
  const nativeStream = await benchmarkMode(filePath, 'native-stream');
  const jsStream = await benchmarkMode(filePath, 'js-stream');

  const nativeSlowdownMs = nativeStream.durationMs - sizeOnly.durationMs;
  const nativeSlowdownPercent = sizeOnly.durationMs > 0
    ? ((nativeSlowdownMs / sizeOnly.durationMs) * 100).toFixed(2)
    : '0.00';
  const jsSlowdownMs = jsStream.durationMs - sizeOnly.durationMs;
  const jsSlowdownPercent = sizeOnly.durationMs > 0
    ? ((jsSlowdownMs / sizeOnly.durationMs) * 100).toFixed(2)
    : '0.00';
  const nativeVsJsSpeedup = nativeStream.durationMs > 0
    ? (jsStream.durationMs / nativeStream.durationMs).toFixed(2)
    : '0.00';

  const result = {
    filePath,
    fileSizeBytes: fileStat.size,
    chunkSizeBytes: CHUNK_SIZE,
    results: [sizeOnly, nativeStream, jsStream],
    comparison: {
      nativeStreamVsSizeOnly: {
        slowdownMs: Number(nativeSlowdownMs.toFixed(2)),
        slowdownPercent: Number(nativeSlowdownPercent),
      },
      jsStreamVsSizeOnly: {
        slowdownMs: Number(jsSlowdownMs.toFixed(2)),
        slowdownPercent: Number(jsSlowdownPercent),
      },
      nativeStreamVsJsStream: {
        speedup: Number(nativeVsJsSpeedup),
      },
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
