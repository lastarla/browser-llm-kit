import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
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

export function createStaticRequestHandler({ distFrontDir, sourceFrontDir, sendJson }) {
  return async function handleStaticRequest(req, res) {
    if (!req.url || !req.url.startsWith('/')) {
      return false;
    }

    try {
      const fileUrl = await ensureStaticFile(req.url, distFrontDir, sourceFrontDir);
      const stream = createReadStream(fileUrl);

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

      res.writeHead(200, {
        'Content-Type': getContentType(req.url),
        ...getCacheHeaders(req.url),
      });
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
