import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.js';
import {
  AUTH_PATH,
  LOGIN_STATUS_PATH,
  PUBLIC_DIR,
  RUNNER_STATUS_PATH,
} from './paths.js';
import { readStatus } from './status.js';

const PORT = Number(process.env.PARIS_TENNIS_PORT ?? 4173);
const HOST = '127.0.0.1';
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function spawnTask(scriptName, argumentsList = []) {
  const child = spawn(process.execPath, [path.join(sourceDirectory, scriptName), ...argumentsList], {
    cwd: path.resolve(sourceDirectory, '..'),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  return child.pid;
}

async function apiStatus() {
  const [config, hasStoredAuth, login, runner] = await Promise.all([
    loadConfig(),
    exists(AUTH_PATH),
    readStatus(LOGIN_STATUS_PATH),
    readStatus(RUNNER_STATUS_PATH),
  ]);
  const loginUpdatedAt = Date.parse(login?.updatedAt ?? '');
  const runnerUpdatedAt = Date.parse(runner?.updatedAt ?? '');
  const sessionInvalidated = runner?.code === 'AUTH_REQUIRED'
    && Number.isFinite(runnerUpdatedAt)
    && (!Number.isFinite(loginUpdatedAt) || runnerUpdatedAt >= loginUpdatedAt);
  return {
    config,
    authenticated: hasStoredAuth && !sessionInvalidated,
    login,
    runner,
    schedule: {
      timezone: 'Europe/Paris',
      time: '08:00',
    },
  };
}

async function serveStatic(requestPath, response) {
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const decodedPath = decodeURIComponent(relativePath);
  const filePath = path.resolve(PUBLIC_DIR, decodedPath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    response.writeHead(200, {
      'Content-Type': MIME_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT') sendJson(response, 404, { error: 'Not found' });
    else throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const host = request.headers.host ?? '';
    if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:')) {
      sendJson(response, 403, { error: 'Local access only' });
      return;
    }

    const url = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, 200, await apiStatus());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config') {
      const config = await saveConfig(await readJson(request));
      sendJson(response, 200, { ok: true, config });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      const pid = spawnTask('login.js');
      sendJson(response, 202, { ok: true, pid });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/run') {
      const body = await readJson(request);
      if (body.dryRun === false && body.confirmLiveBooking !== true) {
        sendJson(response, 400, { error: '真实预约必须经过明确确认。' });
        return;
      }
      const pid = spawnTask(
        'runner.js',
        body.dryRun === false ? ['--headed', '--manual-live'] : ['--dry-run'],
      );
      sendJson(response, 202, { ok: true, pid });
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(url.pathname, response);
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendJson(response, error.validationErrors ? 400 : 500, {
      error: error.message,
      details: error.validationErrors,
    });
  }
});

await loadConfig();
server.listen(PORT, HOST, () => {
  console.log(`Paris Tennis Assistant: http://${HOST}:${PORT}`);
});
