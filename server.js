import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './storage.js';

// Load a local .env if present (for DATABASE_URL etc.). No-op on Replit, where
// the environment is already populated and there is no .env file.
try {
  process.loadEnvFile();
} catch {
  /* no .env — that's fine */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'board.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Set API_KEY in the environment (Replit: Secrets tab) to lock down writes.
// When unset, the board is open — fine for local dev, not for a public URL.
const API_KEY = process.env.API_KEY || '';

/* ------------------------------------------------------------------ store */

let board = null;
let store = null;
let writeTimer = null;

async function loadBoard() {
  store = await createStore(process.env, { dataFile: DATA_FILE });

  let doc;
  try {
    doc = await store.load();
  } catch (err) {
    if (err.fatal) {
      // e.g. a corrupt board.json — preserved, not overwritten. Don't start.
      console.error(`\n✖ ${err.message}`);
      console.error('  Fix or remove that data, then restart.\n');
      process.exit(1);
    }
    console.error(`\n✖ Could not open the ${store.name} store: ${err.message}`);
    if (store.name === 'postgres')
      console.error('  Check DATABASE_URL is correct and the database is reachable.\n');
    process.exit(1);
  }

  if (doc === null) {
    // Empty store → seed it once from data/seed.json.
    board = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8'));
    await persistNow();
  } else {
    board = doc;
  }

  board.agents ||= [];
  board.activity ||= [];
  board.columns ||= [];
}

async function persistNow() {
  clearTimeout(writeTimer);
  writeTimer = null;
  dirtySince = 0;
  await store.save(board);
}

// Writes are coalesced, but never postponed indefinitely: a steady stream of
// agent mutations must still reach disk, so a pending write is forced through
// once it is MAX_WRITE_WAIT old.
const WRITE_DEBOUNCE = 150;
const MAX_WRITE_WAIT = 1000;
let dirtySince = 0;

function persist() {
  const first = dirtySince || (dirtySince = Date.now());
  clearTimeout(writeTimer);
  const wait = Math.max(0, Math.min(WRITE_DEBOUNCE, first + MAX_WRITE_WAIT - Date.now()));
  writeTimer = setTimeout(() => persistNow().catch(console.error), wait);
}

// Don't lose the last change on redeploy, Stop, or Ctrl-C.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    clearTimeout(writeTimer);
    persistNow()
      .catch(console.error)
      .finally(() => process.exit(0));
  });
}

// A single bad request must never take the board offline.
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

const now = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

function logActivity(actor, action, detail, cardId = null) {
  board.activity.unshift({ id: uid('act'), ts: now(), actor, action, detail, cardId });
  board.activity = board.activity.slice(0, 500);
}

function findColumn(id) {
  return board.columns.find((c) => c.id === id);
}

// Agents address sections by id or by title — accept either, reject neither-matches.
function resolveColumn(idOrTitle) {
  if (typeof idOrTitle !== 'string') return null;
  return board.columns.find((c) => c.id === idOrTitle || c.title === idOrTitle) || null;
}

// Returned alongside "unknown column" errors so an agent can self-correct.
const columnIndex = () => board.columns.map((c) => ({ id: c.id, title: c.title }));

function findCard(id) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((c) => c.id === id);
    if (index !== -1) return { card: column.cards[index], column, index };
  }
  return null;
}

/* ------------------------------------------------------------------ events */

const sseClients = new Set();

function broadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/* ------------------------------------------------------------------- http */

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(text);
}

const MAX_BODY_BYTES = 1e6;

// Keys that would let a JSON body reach through an object into its prototype.
const reviveSafely = (key, value) =>
  key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value;

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Collect bytes, not strings: decoding each chunk separately mangles any
    // multi-byte character that straddles a chunk boundary (ü, é, emoji…).
    const chunks = [];
    let bytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        req.destroy();
        return reject(new Error('payload too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!bytes) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'), reviveSafely);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/* -------------------------------------------------------------- validation */

// Agents are programs: a wrong-shaped field must be rejected at the door, not
// stored and then crash every browser rendering the board.
const isPlainText = (v) => typeof v === 'string';
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

class BadRequest extends Error {}

function cleanTitle(value, fallback) {
  if (value === undefined) return fallback;
  if (!isPlainText(value)) throw new BadRequest('title must be a string');
  const text = value.trim();
  if (!text) throw new BadRequest('title must not be empty');
  if (text.length > 500) throw new BadRequest('title must be 500 characters or fewer');
  return text;
}

function cleanLabels(value) {
  if (!Array.isArray(value)) throw new BadRequest('labels must be an array of strings');
  if (!value.every(isPlainText)) throw new BadRequest('labels must be an array of strings');
  return value.map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

function cleanChecklist(value) {
  if (!Array.isArray(value)) throw new BadRequest('checklist must be an array of {text, done}');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !isPlainText(item.text))
      throw new BadRequest('each checklist item must be {text: string, done: boolean}');
    return { text: item.text, done: !!item.done };
  });
}

function cleanColor(value, fallback) {
  if (value === undefined) return fallback;
  // Anything but a plain hex colour is assigned straight into style.background
  // in the browser, which would let an API client beacon out to any URL.
  if (!isPlainText(value) || !HEX_COLOR.test(value.trim()))
    throw new BadRequest('color must be a hex value like #4bc07a');
  return value.trim();
}

function cleanIcon(value, fallback) {
  if (value === undefined) return fallback;
  if (!isPlainText(value)) throw new BadRequest('icon must be a string');
  return [...value].slice(0, 3).join('');
}

function cleanDue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!isPlainText(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new BadRequest('due must be a YYYY-MM-DD date or null');
  return value;
}

// Applies the card fields present in `body`, validating each one.
function applyCardFields(card, body) {
  if ('title' in body) card.title = cleanTitle(body.title, card.title);
  if ('description' in body) {
    if (!isPlainText(body.description)) throw new BadRequest('description must be a string');
    card.description = body.description.slice(0, 20000);
  }
  if ('assignee' in body) {
    if (body.assignee !== null && !isPlainText(body.assignee)) throw new BadRequest('assignee must be a string or null');
    card.assignee = body.assignee || null;
  }
  if ('labels' in body) card.labels = cleanLabels(body.labels);
  if ('due' in body) card.due = cleanDue(body.due);
  if ('status' in body) {
    if (!isPlainText(body.status)) throw new BadRequest('status must be a string');
    card.status = body.status;
  }
  if ('checklist' in body) card.checklist = cleanChecklist(body.checklist);
  return card;
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

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* -------------------------------------------------------------------- api */

// Who is acting: agents identify themselves with X-Actor (or an `actor` field).
function actorOf(req, body) {
  return body?.actor || req.headers['x-actor'] || 'human';
}

function authorized(req) {
  if (!API_KEY) return true;
  const key = req.headers['x-api-key'] || new URL(req.url, 'http://x').searchParams.get('key');
  return key === API_KEY;
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, keys, handler });
};

/* --- board ------------------------------------------------------------- */

route('GET', '/api/board', (req, res) => sendJSON(res, 200, board));

route('PATCH', '/api/board', (req, res, _p, body) => {
  if (typeof body.title === 'string') board.title = body.title;
  persist();
  broadcast('board', board);
  sendJSON(res, 200, board);
});

/* --- columns ----------------------------------------------------------- */

route('POST', '/api/columns', (req, res, _p, body) => {
  const column = {
    id: uid('col'),
    title: cleanTitle(body.title, 'New section'),
    color: cleanColor(body.color, '#8b93a7'),
    icon: cleanIcon(body.icon, '📋'),
    wipLimit: Number.isInteger(body.wipLimit) ? body.wipLimit : null,
    cards: [],
  };
  board.columns.push(column);
  logActivity(actorOf(req, body), 'created section', column.title);
  persist();
  broadcast('board', board);
  sendJSON(res, 201, column);
});

route('PATCH', '/api/columns/:id', (req, res, p, body) => {
  const column = findColumn(p.id);
  if (!column) return sendJSON(res, 404, { error: 'column not found' });
  if ('title' in body) column.title = cleanTitle(body.title, column.title);
  if ('color' in body) column.color = cleanColor(body.color, column.color);
  if ('icon' in body) column.icon = cleanIcon(body.icon, column.icon);
  if ('wipLimit' in body) column.wipLimit = Number.isInteger(body.wipLimit) ? body.wipLimit : null;
  if (Number.isInteger(body.position)) {
    const from = board.columns.indexOf(column);
    board.columns.splice(from, 1);
    board.columns.splice(Math.max(0, Math.min(body.position, board.columns.length)), 0, column);
  }
  persist();
  broadcast('board', board);
  sendJSON(res, 200, column);
});

route('DELETE', '/api/columns/:id', (req, res, p) => {
  const column = findColumn(p.id);
  if (!column) return sendJSON(res, 404, { error: 'column not found' });
  board.columns.splice(board.columns.indexOf(column), 1);
  logActivity(actorOf(req), 'deleted section', column.title);
  persist();
  broadcast('board', board);
  sendJSON(res, 200, { ok: true });
});

/* --- cards ------------------------------------------------------------- */

// GET /api/cards?assignee=agent_x&column=Focus&label=urgent&q=text
route('GET', '/api/cards', (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const out = [];
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (q.get('assignee') && card.assignee !== q.get('assignee')) continue;
      if (q.get('column') && column.id !== q.get('column') && column.title !== q.get('column')) continue;
      if (q.get('label') && !(card.labels || []).includes(q.get('label'))) continue;
      if (q.get('status') && card.status !== q.get('status')) continue;
      const text = q.get('q');
      if (text && !`${card.title} ${card.description || ''}`.toLowerCase().includes(text.toLowerCase())) continue;
      out.push({ ...card, columnId: column.id, columnTitle: column.title });
    }
  }
  sendJSON(res, 200, { count: out.length, cards: out });
});

route('GET', '/api/cards/:id', (req, res, p) => {
  const hit = findCard(p.id);
  if (!hit) return sendJSON(res, 404, { error: 'card not found' });
  sendJSON(res, 200, { ...hit.card, columnId: hit.column.id, columnTitle: hit.column.title });
});

route('POST', '/api/cards', (req, res, _p, body) => {
  // A named-but-unknown section is a typo, not a request to file it anywhere.
  const named = body.columnId ?? body.column;
  const column = named === undefined || named === null ? board.columns[0] : resolveColumn(named);
  if (named !== undefined && named !== null && !column)
    return sendJSON(res, 400, { error: `unknown column: ${named}`, columns: columnIndex() });
  if (!column) return sendJSON(res, 400, { error: 'no column to add to' });

  const card = applyCardFields(
    {
      id: uid('card'),
      title: 'Untitled task',
      description: '',
      assignee: null,
      labels: [],
      due: null,
      status: 'open',
      checklist: [],
      comments: [],
      createdBy: actorOf(req, body),
      createdAt: now(),
      updatedAt: now(),
    },
    body
  );
  const at = Number.isInteger(body.position) ? body.position : column.cards.length;
  column.cards.splice(Math.max(0, Math.min(at, column.cards.length)), 0, card);
  logActivity(card.createdBy, 'created task', card.title, card.id);
  persist();
  broadcast('board', board);
  sendJSON(res, 201, { ...card, columnId: column.id });
});

route('PATCH', '/api/cards/:id', (req, res, p, body) => {
  const hit = findCard(p.id);
  if (!hit) return sendJSON(res, 404, { error: 'card not found' });
  const { card, column, index } = hit;
  const actor = actorOf(req, body);

  // Resolve the destination BEFORE mutating anything: a move to a section that
  // doesn't exist must fail outright, not return 200 having quietly done nothing.
  const named = body.columnId ?? body.column;
  const target = named === undefined || named === null ? null : resolveColumn(named);
  if (named !== undefined && named !== null && !target)
    return sendJSON(res, 404, { error: `unknown column: ${named}`, columns: columnIndex() });

  applyCardFields(card, body);

  if (target && (target !== column || Number.isInteger(body.position))) {
    column.cards.splice(index, 1);
    const at = Number.isInteger(body.position) ? body.position : target.cards.length;
    target.cards.splice(Math.max(0, Math.min(at, target.cards.length)), 0, card);
    if (target !== column) logActivity(actor, 'moved task', `${card.title} → ${target.title}`, card.id);
  } else if (!target && Number.isInteger(body.position)) {
    column.cards.splice(index, 1);
    column.cards.splice(Math.max(0, Math.min(body.position, column.cards.length)), 0, card);
  }

  card.updatedAt = now();
  if (!target || target === column) logActivity(actor, 'updated task', card.title, card.id);
  persist();
  broadcast('board', board);
  sendJSON(res, 200, card);
});

route('DELETE', '/api/cards/:id', (req, res, p) => {
  const hit = findCard(p.id);
  if (!hit) return sendJSON(res, 404, { error: 'card not found' });
  hit.column.cards.splice(hit.index, 1);
  logActivity(actorOf(req), 'deleted task', hit.card.title, hit.card.id);
  persist();
  broadcast('board', board);
  sendJSON(res, 200, { ok: true });
});

// An agent grabs a task so two agents don't work the same one.
route('POST', '/api/cards/:id/claim', (req, res, p, body) => {
  const hit = findCard(p.id);
  if (!hit) return sendJSON(res, 404, { error: 'card not found' });
  const actor = actorOf(req, body);
  if (hit.card.assignee && hit.card.assignee !== actor && !body.force) {
    return sendJSON(res, 409, { error: 'already assigned', assignee: hit.card.assignee });
  }
  hit.card.assignee = actor;
  hit.card.status = 'in_progress';
  hit.card.updatedAt = now();
  logActivity(actor, 'claimed task', hit.card.title, hit.card.id);
  persist();
  broadcast('board', board);
  sendJSON(res, 200, hit.card);
});

route('POST', '/api/cards/:id/comments', (req, res, p, body) => {
  const hit = findCard(p.id);
  if (!hit) return sendJSON(res, 404, { error: 'card not found' });
  if (!isPlainText(body.text) || !body.text.trim()) return sendJSON(res, 400, { error: 'text is required' });
  const comment = { id: uid('cm'), author: actorOf(req, body), text: body.text.slice(0, 20000), ts: now() };
  hit.card.comments.push(comment);
  hit.card.updatedAt = now();
  logActivity(comment.author, 'commented on', hit.card.title, hit.card.id);
  persist();
  broadcast('board', board);
  sendJSON(res, 201, comment);
});

/* --- agents ------------------------------------------------------------ */

// A finished task is not workload — an orchestrator routing by openTasks would
// otherwise starve whichever agent has completed the most.
const isOpenWork = (card) => card.status !== 'done';

route('GET', '/api/agents', (req, res) => {
  const load = {};
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.assignee && isOpenWork(card)) load[card.assignee] = (load[card.assignee] || 0) + 1;
    }
  }
  sendJSON(res, 200, board.agents.map((a) => ({ ...a, openTasks: load[a.id] || 0 })));
});

route('POST', '/api/agents', (req, res, _p, body) => {
  if (!isPlainText(body.id) || !body.id.trim()) return sendJSON(res, 400, { error: 'id is required' });
  const existing = board.agents.find((a) => a.id === body.id);
  const agent = existing || { id: body.id.trim(), createdAt: now() };
  agent.name = cleanTitle(body.name, agent.name || agent.id);
  agent.role = isPlainText(body.role) ? body.role : agent.role || 'agent';
  agent.avatar = cleanIcon(body.avatar, agent.avatar || '🤖');
  agent.color = cleanColor(body.color, agent.color || '#6b7ce0');
  agent.skills = Array.isArray(body.skills) ? body.skills.filter(isPlainText) : agent.skills || [];
  agent.lastSeen = now();
  if (!existing) board.agents.push(agent);
  persist();
  broadcast('board', board);
  sendJSON(res, existing ? 200 : 201, agent);
});

route('DELETE', '/api/agents/:id', (req, res, p) => {
  const i = board.agents.findIndex((a) => a.id === p.id);
  if (i === -1) return sendJSON(res, 404, { error: 'agent not found' });
  board.agents.splice(i, 1);
  persist();
  broadcast('board', board);
  sendJSON(res, 200, { ok: true });
});

/* --- activity ---------------------------------------------------------- */

route('GET', '/api/activity', (req, res) => {
  const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') || 50);
  sendJSON(res, 200, board.activity.slice(0, limit));
});

/* ------------------------------------------------------------------ serve */

// Every request goes through here inside a try/catch: no single malformed
// request may be allowed to take the board offline for everyone.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) sendJSON(res, err instanceof BadRequest ? 400 : 500, { error: err.message });
    else res.end();
  });
});

async function handle(req, res) {
  // `new URL()` throws on targets with an empty authority ("//", "///", "//?x").
  // A browser will send those from nothing worse than a doubled slash in a link.
  let urlPath;
  try {
    urlPath = new URL(req.url, 'http://x').pathname;
  } catch {
    return sendJSON(res, 400, { error: 'bad request target' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Actor',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    });
    return res.end();
  }

  // Live board updates for every connected browser.
  if (urlPath === '/api/events') {
    if (!authorized(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: board\ndata: ${JSON.stringify(board)}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (!urlPath.startsWith('/api/')) return serveStatic(req, res, urlPath);

  if (!authorized(req)) return sendJSON(res, 401, { error: 'unauthorized — send X-API-Key' });

  const match = routes.find((r) => r.method === req.method && r.regex.test(urlPath));
  if (!match) return sendJSON(res, 404, { error: `no route for ${req.method} ${urlPath}` });

  // decodeURIComponent throws URIError on a stray '%' — an id an agent built by
  // string interpolation can easily contain one.
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const values = urlPath.match(match.regex).slice(1);
  const params = Object.fromEntries(match.keys.map((k, i) => [k, decode(values[i])]));

  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    await match.handler(req, res, params, body);
  } catch (err) {
    sendJSON(res, 400, { error: err.message });
  }
}

await loadBoard();
server.listen(PORT, () => {
  console.log(`workforce board → http://localhost:${PORT}`);
  console.log(`storage: ${store.describe}`);
  console.log(API_KEY ? 'auth: API_KEY required' : 'auth: open (set API_KEY to lock down)');
});
