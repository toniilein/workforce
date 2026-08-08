import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
let writeTimer = null;

async function loadBoard() {
  try {
    board = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
  } catch {
    board = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8'));
    await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await persistNow();
  }
  board.agents ||= [];
  board.activity ||= [];
  board.columns ||= [];
}

async function persistNow() {
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(board, null, 2));
  await fsp.rename(tmp, DATA_FILE);
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => persistNow().catch(console.error), 150);
}

const now = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

function logActivity(actor, action, detail, cardId = null) {
  board.activity.unshift({ id: uid('act'), ts: now(), actor, action, detail, cardId });
  board.activity = board.activity.slice(0, 500);
}

function findColumn(id) {
  return board.columns.find((c) => c.id === id);
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
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
    title: body.title || 'New section',
    color: body.color || '#8b93a7',
    icon: body.icon || '📋',
    wipLimit: body.wipLimit ?? null,
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
  for (const field of ['title', 'color', 'icon', 'wipLimit']) {
    if (field in body) column[field] = body[field];
  }
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
  const column = findColumn(body.columnId) || board.columns.find((c) => c.title === body.column) || board.columns[0];
  if (!column) return sendJSON(res, 400, { error: 'no column to add to' });
  const card = {
    id: uid('card'),
    title: body.title || 'Untitled task',
    description: body.description || '',
    assignee: body.assignee || null,
    labels: body.labels || [],
    due: body.due || null,
    status: body.status || 'open',
    checklist: body.checklist || [],
    comments: [],
    createdBy: actorOf(req, body),
    createdAt: now(),
    updatedAt: now(),
  };
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

  for (const field of ['title', 'description', 'assignee', 'labels', 'due', 'status', 'checklist']) {
    if (field in body) card[field] = body[field];
  }

  const target = body.columnId
    ? findColumn(body.columnId) || board.columns.find((c) => c.title === body.columnId)
    : null;
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
  if (!body.text) return sendJSON(res, 400, { error: 'text is required' });
  const comment = { id: uid('cm'), author: actorOf(req, body), text: body.text, ts: now() };
  hit.card.comments.push(comment);
  hit.card.updatedAt = now();
  logActivity(comment.author, 'commented on', hit.card.title, hit.card.id);
  persist();
  broadcast('board', board);
  sendJSON(res, 201, comment);
});

/* --- agents ------------------------------------------------------------ */

route('GET', '/api/agents', (req, res) => {
  const load = {};
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.assignee) load[card.assignee] = (load[card.assignee] || 0) + 1;
    }
  }
  sendJSON(res, 200, board.agents.map((a) => ({ ...a, openTasks: load[a.id] || 0 })));
});

route('POST', '/api/agents', (req, res, _p, body) => {
  if (!body.id) return sendJSON(res, 400, { error: 'id is required' });
  const existing = board.agents.find((a) => a.id === body.id);
  const agent = existing || { id: body.id, createdAt: now() };
  agent.name = body.name || agent.name || body.id;
  agent.role = body.role || agent.role || 'agent';
  agent.avatar = body.avatar || agent.avatar || '🤖';
  agent.color = body.color || agent.color || '#6b7ce0';
  agent.skills = body.skills || agent.skills || [];
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

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;

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

  const values = urlPath.match(match.regex).slice(1);
  const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));

  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    await match.handler(req, res, params, body);
  } catch (err) {
    sendJSON(res, 400, { error: err.message });
  }
});

await loadBoard();
server.listen(PORT, () => {
  console.log(`workforce board → http://localhost:${PORT}`);
  console.log(API_KEY ? 'auth: API_KEY required' : 'auth: open (set API_KEY to lock down)');
});
