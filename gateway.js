/*
 * Gateway — serves the board and talks to GitHub on its behalf.
 *
 * The GitHub Pages build has to ask each browser for a token, because a static
 * page cannot keep a secret. Running the same board from here removes that: the
 * token lives in this process (GITHUB_TOKEN in Replit Secrets), and the browser
 * just calls this server. Data still lives as .md files in the repo, so history
 * and git-based agents are unchanged.
 *
 * Endpoints (all same-origin, no token in the browser):
 *   GET    /api/config            what the frontend needs to know
 *   GET    /api/tasks             every task file with its text and sha
 *   PUT    /api/tasks/:file       {text, sha?, message} -> commit
 *   DELETE /api/tasks/:file       {sha, message}        -> commit
 *
 * Set BOARD_PASSWORD to require a password before anything can be changed.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  /* no .env — fine, Replit provides the environment directly */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'docs');
const PORT = process.env.PORT || 3000;

const REPO = {
  owner: process.env.REPO_OWNER || 'toniilein',
  name: process.env.REPO_NAME || 'workforce',
  branch: process.env.REPO_BRANCH || 'main',
  dir: process.env.TASKS_DIR || 'tasks',
};

const TOKEN = process.env.GITHUB_TOKEN || '';
const PASSWORD = process.env.BOARD_PASSWORD || '';

/* ------------------------------------------------------------------ github */

const API = 'https://api.github.com';
const contentsUrl = (file) =>
  `${API}/repos/${REPO.owner}/${REPO.name}/contents/${REPO.dir}${file ? `/${encodeURIComponent(file)}` : ''}`;

async function github(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workforce-board',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(body?.message || `GitHub returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function listTasks() {
  const entries = await github(`${contentsUrl()}?ref=${REPO.branch}`);
  const files = entries.filter(
    (f) => f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md'
  );
  // Fetch contents in parallel; the API returns them base64-encoded.
  return Promise.all(
    files.map(async (f) => {
      const full = await github(`${contentsUrl(f.name)}?ref=${REPO.branch}`);
      return { file: f.name, sha: full.sha, text: Buffer.from(full.content, 'base64').toString('utf8') };
    })
  );
}

const writeTask = (file, text, message, sha) =>
  github(contentsUrl(file), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: REPO.branch,
      ...(sha ? { sha } : {}),
    }),
  });

const removeTask = (file, message, sha) =>
  github(contentsUrl(file), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: REPO.branch }),
  });

/* -------------------------------------------------------------------- http */

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > 2e6) {
        req.destroy();
        return reject(new Error('payload too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!bytes) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Timing-safe compare so the password can't be guessed byte by byte.
function passwordOk(given) {
  if (!PASSWORD) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ routes */

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return send(res, 400, { error: 'bad request target' });
  }
  const p = url.pathname;

  if (!p.startsWith('/api/')) return serveStatic(res, p);

  // Tells the frontend it is running against a gateway, so it hides all the
  // token UI and calls these routes instead of api.github.com.
  if (p === '/api/config' && req.method === 'GET') {
    return send(res, 200, {
      mode: 'gateway',
      repo: REPO,
      canWrite: Boolean(TOKEN),
      needsPassword: Boolean(PASSWORD),
    });
  }

  if (p === '/api/tasks' && req.method === 'GET') {
    try {
      return send(res, 200, { tasks: await listTasks() });
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  const match = /^\/api\/tasks\/([^/]+)$/.exec(p);
  if (match && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!TOKEN) return send(res, 503, { error: 'This board is read-only: no GITHUB_TOKEN is configured.' });

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    if (!passwordOk(req.headers['x-board-password'] || body.password))
      return send(res, 401, { error: 'Wrong board password.' });

    let file;
    try {
      file = decodeURIComponent(match[1]);
    } catch {
      return send(res, 400, { error: 'bad file name' });
    }
    // Keep writes inside tasks/: no traversal, no stray file types.
    if (!/^[\w.-]+\.md$/.test(file)) return send(res, 400, { error: 'invalid task file name' });

    try {
      const result =
        req.method === 'PUT'
          ? await writeTask(file, String(body.text ?? ''), body.message || `task: update ${file}`, body.sha)
          : await removeTask(file, body.message || `task: remove ${file}`, body.sha);
      return send(res, 200, { ok: true, sha: result?.content?.sha ?? null });
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  send(res, 404, { error: `no route for ${req.method} ${p}` });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  });
});

process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

// The UI is served from this checkout, so a Repl that hasn't pulled serves an
// old board. Print which commit is running to make that visible immediately.
function localCommit() {
  try {
    const head = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? fs.readFileSync(path.join(__dirname, '.git', ref), 'utf8').trim() : head;
    return sha.slice(0, 7);
  } catch {
    return 'unknown';
  }
}

server.listen(PORT, () => {
  console.log(`board gateway → http://localhost:${PORT}`);
  console.log(`serving commit: ${localCommit()}`);
  console.log(`repo: ${REPO.owner}/${REPO.name}@${REPO.branch}/${REPO.dir}`);
  console.log(TOKEN ? 'github: token loaded (writes enabled)' : 'github: NO TOKEN — read-only');
  console.log(PASSWORD ? 'access: password required for changes' : 'access: open (set BOARD_PASSWORD to lock)');
});
