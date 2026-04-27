import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

const STATIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const LONG_LIVED_STATIC_EXTENSIONS = new Set(['.task', '.wasm']);

function resolveStaticPath(urlPath, baseDir) {
  const normalizedPath = urlPath === '/' ? '/index.html' : urlPath;
  const fileUrl = new URL(`.${normalizedPath}`, baseDir);

  if (!fileUrl.href.startsWith(baseDir.href)) {
    return null;
  }

  return fileUrl;
}

function getStaticCandidateDirs(urlPath, distFrontDir, sourceFrontDir) {
  const candidates = [distFrontDir];

  if (urlPath.startsWith('/assets/')) {
    candidates.push(sourceFrontDir);
  }

  return candidates;
}

async function ensureStaticFile(urlPath, distFrontDir, sourceFrontDir) {
  const candidateDirs = getStaticCandidateDirs(urlPath, distFrontDir, sourceFrontDir);
  let sawValidPath = false;

  for (const candidateDir of candidateDirs) {
    const fileUrl = resolveStaticPath(urlPath, candidateDir);
    if (!fileUrl) {
      continue;
    }

    sawValidPath = true;

    try {
      await access(fileUrl);
      return fileUrl;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(sawValidPath ? 'STATIC_FILE_NOT_FOUND' : 'STATIC_PATH_INVALID');
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!extension && filePath === '/') {
    return STATIC_CONTENT_TYPES['.html'];
  }

  return STATIC_CONTENT_TYPES[extension] || 'application/octet-stream';
}

function getCacheHeaders(filePath) {
  if (LONG_LIVED_STATIC_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return {
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
  }

  return {
    'Cache-Control': 'no-store',
  };
}

function parseRangeHeader(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  let start;
  let end;

  if (rawStart) {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1;
  } else {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return null;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1),
  };
}

export function createStaticRequestHandler({ distFrontDir, sourceFrontDir, sendJson }) {
  return async function handleStaticRequest(req, res) {
    if (!req.url || !req.url.startsWith('/')) {
      return false;
    }

    try {
      const fileUrl = await ensureStaticFile(req.url, distFrontDir, sourceFrontDir);
      const fileStats = await stat(fileUrl);
      const range = req.method === 'GET' ? parseRangeHeader(req.headers?.range, fileStats.size) : null;
      if (req.method === 'GET' && req.headers?.range && !range) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileStats.size}`,
          'Accept-Ranges': 'bytes',
        });
        res.end();
        return true;
      }

      const statusCode = range ? 206 : 200;
      const contentLength = range ? (range.end - range.start + 1) : fileStats.size;
      const headers = {
        'Content-Type': getContentType(req.url),
        'Content-Length': String(contentLength),
        'Last-Modified': fileStats.mtime.toUTCString(),
        ETag: `W/\"${fileStats.size}-${Math.trunc(fileStats.mtimeMs)}\"`,
        'Accept-Ranges': 'bytes',
        ...getCacheHeaders(req.url),
      };
      if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${fileStats.size}`;
      }

      if (req.method === 'HEAD') {
        res.writeHead(statusCode, headers);
        res.end();
        return true;
      }

      const stream = createReadStream(fileUrl, range || undefined);

      stream.on('error', (error) => {
        if (!res.headersSent) {
          sendJson(res, 404, {
            error: '静态文件不存在',
            details: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        res.destroy(error);
      });

      res.writeHead(statusCode, headers);
      stream.pipe(res);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'STATIC_PATH_INVALID' || message === 'STATIC_FILE_NOT_FOUND') {
        return false;
      }

      sendJson(res, 404, {
        error: '静态文件不存在',
        details: message,
      });
      return true;
    }
  };
}
