/* Workforce — Kanban for a human + AI-agent team */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let board = { columns: [], agents: [], activity: [] };
let openCardId = null;
let filter = { text: '', assignee: '' };

/* ------------------------------------------------------------------- api */

const apiKey = () => localStorage.getItem('workforce_key') || '';
const me = () => localStorage.getItem('workforce_me') || 'human';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey(),
      'X-Actor': me(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    alert(err.error || 'Request failed');
    throw new Error(err.error);
  }
  return res.json();
}

/* ------------------------------------------------------------- rendering */

const agentById = (id) => board.agents.find((a) => a.id === id);

function avatarNode(assigneeId) {
  const agent = agentById(assigneeId);
  const node = el('div', 'avatar' + (agent ? '' : ' empty'));
  node.textContent = agent ? agent.avatar || '🤖' : '👤';
  node.title = agent ? `${agent.name} (${agent.role})` : 'Unassigned';
  if (agent) node.style.background = agent.color || '#6b7ce0';
  return node;
}

function matchesFilter(card) {
  if (filter.assignee && card.assignee !== filter.assignee) return false;
  if (filter.text) {
    const hay = `${card.title} ${card.description || ''} ${(card.labels || []).join(' ')}`.toLowerCase();
    if (!hay.includes(filter.text)) return false;
  }
  return true;
}

function cardNode(card, column) {
  const node = el('div', `card ${card.status || 'open'}`);
  node.draggable = true;
  node.dataset.id = card.id;

  node.appendChild(el('div', 'card-title', card.title));
  node.appendChild(avatarNode(card.assignee));

  const meta = el('div', 'card-meta');
  for (const label of card.labels || []) meta.appendChild(el('span', 'label', label));
  if (card.due) {
    const overdue = new Date(card.due) < new Date(new Date().toDateString());
    meta.appendChild(el('span', 'due' + (overdue ? ' overdue' : ''), `📅 ${formatDate(card.due)}`));
  }
  const checks = card.checklist || [];
  if (checks.length) meta.appendChild(el('span', 'badge', `☑ ${checks.filter((c) => c.done).length}/${checks.length}`));
  if ((card.comments || []).length) meta.appendChild(el('span', 'badge', `💬 ${card.comments.length}`));
  if (meta.childElementCount) node.appendChild(meta);

  node.addEventListener('click', () => openCard(card.id));
  node.addEventListener('dragstart', (e) => {
    node.classList.add('dragging');
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
  return node;
}

function columnNode(column) {
  const wrap = el('div', 'column');
  wrap.dataset.id = column.id;

  const head = el('div', 'col-head');
  head.style.background = column.color;
  head.appendChild(el('span', 'icon', column.icon || '📋'));
  const title = el('span', 'title', column.title);
  head.appendChild(title);
  const visible = column.cards.filter(matchesFilter);
  head.appendChild(el('span', 'count', String(visible.length)));

  // double-click the header to rename, right-click to recolor / delete
  head.addEventListener('dblclick', () => {
    const input = el('input');
    input.value = column.title;
    head.replaceChild(input, title);
    input.focus();
    input.select();
    const commit = () => api('PATCH', `/api/columns/${column.id}`, { title: input.value.trim() || column.title });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') render();
    });
    input.addEventListener('blur', commit);
  });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const color = prompt('Section colour (hex) — leave empty and confirm delete to remove section', column.color);
    if (color === null) return;
    if (color.trim() === '') {
      if (confirm(`Delete section "${column.title}" and its ${column.cards.length} tasks?`))
        api('DELETE', `/api/columns/${column.id}`);
      return;
    }
    const icon = prompt('Section icon (emoji)', column.icon || '📋') ?? column.icon;
    api('PATCH', `/api/columns/${column.id}`, { color: color.trim(), icon });
  });

  const body = el('div', 'col-body');
  for (const card of visible) body.appendChild(cardNode(card, column));

  const add = el('button', 'add-card', '+');
  add.addEventListener('click', () => startNewCard(column, body, add));
  body.appendChild(add);

  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    wrap.classList.add('drop-target');
  });
  body.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop-target');
    const cardId = e.dataTransfer.getData('text/plain');
    if (!cardId) return;
    const position = dropIndex(body, e.clientY, cardId);
    api('PATCH', `/api/cards/${cardId}`, { columnId: column.id, position });
  });

  wrap.append(head, body);
  return wrap;
}

// Where in the column did the pointer land?
function dropIndex(body, y, draggedId) {
  const cards = [...body.querySelectorAll('.card')].filter((c) => c.dataset.id !== draggedId);
  for (let i = 0; i < cards.length; i++) {
    const box = cards[i].getBoundingClientRect();
    if (y < box.top + box.height / 2) return i;
  }
  return cards.length;
}

function startNewCard(column, body, addBtn) {
  const input = el('textarea', 'new-card-input');
  input.rows = 2;
  input.placeholder = 'Task title — Enter to save, Esc to cancel';
  body.insertBefore(input, addBtn);
  input.focus();
  let done = false;
  const save = async () => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (title) await api('POST', '/api/cards', { columnId: column.id, title });
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
    if (e.key === 'Escape') {
      done = true;
      render();
    }
  });
  input.addEventListener('blur', save);
}

function render() {
  const scroll = $('#board').scrollLeft;
  const root = $('#board');
  root.innerHTML = '';
  for (const column of board.columns) root.appendChild(columnNode(column));

  const addCol = el('button', 'add-column', '+');
  addCol.title = 'Add section';
  addCol.addEventListener('click', async () => {
    const title = prompt('Section name');
    if (!title) return;
    const palette = ['#3d4451', '#f5c343', '#f0a441', '#ec5f8f', '#e2504f', '#4bc07a', '#9b7bd4', '#4f8ef7'];
    await api('POST', '/api/columns', { title, color: palette[board.columns.length % palette.length] });
  });
  root.appendChild(addCol);
  root.scrollLeft = scroll;

  $('#board-title').textContent = board.title || 'Workforce';
  renderAssigneeFilter();
  if (openCardId && !$('#drawer').hidden) renderDrawer();
  if (!$('#team').hidden) renderTeam();
  if (!$('#activity').hidden) renderActivity();
}

function renderAssigneeFilter() {
  const sel = $('#filter-assignee');
  const current = sel.value;
  sel.innerHTML = '<option value="">All members</option>';
  for (const agent of board.agents) {
    const opt = el('option', null, `${agent.avatar || '🤖'} ${agent.name}`);
    opt.value = agent.id;
    sel.appendChild(opt);
  }
  sel.value = current;
}

/* ------------------------------------------------------------ card drawer */

function locate(cardId) {
  for (const column of board.columns) {
    const card = column.cards.find((c) => c.id === cardId);
    if (card) return { card, column };
  }
  return null;
}

function openCard(id) {
  openCardId = id;
  closePanels();
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  renderDrawer();
}

function renderDrawer() {
  const hit = locate(openCardId);
  if (!hit) return closeDrawer();
  const { card, column } = hit;
  const focused = document.activeElement;
  const editing = focused && $('#drawer').contains(focused) && /INPUT|TEXTAREA|SELECT/.test(focused.tagName);

  const chip = $('#drawer-section');
  chip.textContent = `${column.icon || ''} ${column.title}`.trim();
  chip.style.background = column.color;

  if (!editing) {
    $('#d-title').value = card.title;
    $('#d-desc').value = card.description || '';
    $('#d-due').value = card.due || '';
    $('#d-labels').value = (card.labels || []).join(', ');
  }

  const assignee = $('#d-assignee');
  assignee.innerHTML = '<option value="">Unassigned</option>';
  for (const agent of board.agents) {
    const opt = el('option', null, `${agent.avatar || '🤖'} ${agent.name} — ${agent.role}`);
    opt.value = agent.id;
    assignee.appendChild(opt);
  }
  assignee.value = card.assignee || '';

  const colSel = $('#d-column');
  colSel.innerHTML = '';
  for (const c of board.columns) {
    const opt = el('option', null, c.title);
    opt.value = c.id;
    colSel.appendChild(opt);
  }
  colSel.value = column.id;

  const list = $('#d-checklist');
  list.innerHTML = '';
  (card.checklist || []).forEach((item, i) => {
    const li = el('li', item.done ? 'done' : '');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!item.done;
    box.addEventListener('change', () => {
      const next = card.checklist.map((c, j) => (j === i ? { ...c, done: box.checked } : c));
      api('PATCH', `/api/cards/${card.id}`, { checklist: next });
    });
    const remove = el('button', 'icon-btn', '✕');
    remove.addEventListener('click', () =>
      api('PATCH', `/api/cards/${card.id}`, { checklist: card.checklist.filter((_, j) => j !== i) })
    );
    li.append(box, el('span', null, item.text), remove);
    list.appendChild(li);
  });

  const comments = $('#d-comments');
  comments.innerHTML = '';
  for (const c of card.comments || []) {
    const node = el('div', 'comment');
    const head = el('div');
    const agent = agentById(c.author);
    head.appendChild(el('span', 'who', agent ? `${agent.avatar || '🤖'} ${agent.name}` : c.author));
    head.appendChild(el('span', 'when', formatTime(c.ts)));
    node.append(head, el('div', 'text', c.text));
    comments.appendChild(node);
  }
  if (!card.comments?.length) comments.appendChild(el('div', 'muted small', 'No messages yet.'));

  $('#d-meta').textContent = `${card.id} · created by ${card.createdBy || '—'}`;
}

function closeDrawer() {
  openCardId = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

function closePanels() {
  $('#team').hidden = true;
  $('#activity').hidden = true;
}

function patchOpenCard(patch) {
  if (!openCardId) return;
  api('PATCH', `/api/cards/${openCardId}`, patch);
}

/* ------------------------------------------------------------ side panels */

function renderTeam() {
  const list = $('#team-list');
  list.innerHTML = '';
  const load = {};
  for (const column of board.columns)
    for (const card of column.cards) if (card.assignee) load[card.assignee] = (load[card.assignee] || 0) + 1;

  for (const agent of board.agents) {
    const row = el('div', 'team-row');
    const av = el('div', 'avatar', agent.avatar || '🤖');
    av.style.background = agent.color || '#6b7ce0';
    const info = el('div');
    info.style.flex = '1';
    info.appendChild(el('div', 'who', agent.name));
    info.appendChild(
      el('div', 'sub', `${agent.role} · ${load[agent.id] || 0} open · ${(agent.skills || []).join(', ') || 'no skills listed'}`)
    );
    const beMe = el('button', 'ghost small', me() === agent.id ? '✓ you' : 'act as');
    beMe.addEventListener('click', () => {
      localStorage.setItem('workforce_me', agent.id);
      renderTeam();
    });
    const del = el('button', 'icon-btn', '✕');
    del.addEventListener('click', () => confirm(`Remove ${agent.name}?`) && api('DELETE', `/api/agents/${agent.id}`));
    row.append(av, info, beMe, del);
    list.appendChild(row);
  }
  $('#apikey').value = apiKey();
}

function renderActivity() {
  const list = $('#activity-list');
  list.innerHTML = '';
  for (const act of board.activity.slice(0, 80)) {
    const agent = agentById(act.actor);
    const node = el('div', 'act');
    const line = el('div');
    line.appendChild(el('span', 'who', agent ? `${agent.avatar || '🤖'} ${agent.name}` : act.actor));
    line.appendChild(document.createTextNode(` ${act.action} `));
    line.appendChild(el('span', null, act.detail || ''));
    node.append(line, el('div', 'when', formatTime(act.ts)));
    if (act.cardId) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => openCard(act.cardId));
    }
    list.appendChild(node);
  }
  if (!board.activity.length) list.appendChild(el('div', 'muted small', 'Nothing has happened yet.'));
}

/* --------------------------------------------------------------- helpers */

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatTime(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ---------------------------------------------------------------- wiring */

$('#search').addEventListener('input', (e) => {
  filter.text = e.target.value.trim().toLowerCase();
  render();
});
$('#filter-assignee').addEventListener('change', (e) => {
  filter.assignee = e.target.value;
  render();
});
$('#btn-team').addEventListener('click', () => {
  const open = $('#team').hidden;
  closeDrawer();
  closePanels();
  $('#team').hidden = !open;
  $('#scrim').hidden = !open;
  if (open) renderTeam();
});
$('#btn-activity').addEventListener('click', () => {
  const open = $('#activity').hidden;
  closeDrawer();
  closePanels();
  $('#activity').hidden = !open;
  $('#scrim').hidden = !open;
  if (open) renderActivity();
});
$('#scrim').addEventListener('click', () => {
  closeDrawer();
  closePanels();
});
document.querySelectorAll('[data-close]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $(`#${btn.dataset.close}`).hidden = true;
    $('#scrim').hidden = true;
  })
);
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawer();
    closePanels();
    $('#scrim').hidden = true;
  }
});

$('#d-title').addEventListener('change', (e) => patchOpenCard({ title: e.target.value.trim() }));
$('#d-desc').addEventListener('change', (e) => patchOpenCard({ description: e.target.value }));
$('#d-due').addEventListener('change', (e) => patchOpenCard({ due: e.target.value || null }));
$('#d-labels').addEventListener('change', (e) =>
  patchOpenCard({ labels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
);
$('#d-assignee').addEventListener('change', (e) => patchOpenCard({ assignee: e.target.value || null }));
$('#d-column').addEventListener('change', (e) => patchOpenCard({ columnId: e.target.value }));
$('#d-delete').addEventListener('click', () => {
  if (!openCardId || !confirm('Delete this task?')) return;
  const id = openCardId;
  closeDrawer();
  api('DELETE', `/api/cards/${id}`);
});

$('#d-check-add').addEventListener('click', addCheckItem);
$('#d-check-new').addEventListener('keydown', (e) => e.key === 'Enter' && addCheckItem());
function addCheckItem() {
  const input = $('#d-check-new');
  const text = input.value.trim();
  const hit = locate(openCardId);
  if (!text || !hit) return;
  input.value = '';
  api('PATCH', `/api/cards/${openCardId}`, { checklist: [...(hit.card.checklist || []), { text, done: false }] });
}

$('#d-comment-send').addEventListener('click', sendComment);
$('#d-comment-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendComment();
});
function sendComment() {
  const input = $('#d-comment-new');
  const text = input.value.trim();
  if (!text || !openCardId) return;
  input.value = '';
  api('POST', `/api/cards/${openCardId}/comments`, { text });
}

$('#a-add').addEventListener('click', async () => {
  const id = $('#a-id').value.trim();
  if (!id) return alert('An id is required (e.g. research).');
  await api('POST', '/api/agents', {
    id,
    name: $('#a-name').value.trim() || id,
    avatar: $('#a-avatar').value.trim() || '🤖',
    role: $('#a-role').value.trim() || 'agent',
  });
  ['#a-id', '#a-name', '#a-avatar', '#a-role'].forEach((s) => ($(s).value = ''));
});
$('#apikey-save').addEventListener('click', () => {
  localStorage.setItem('workforce_key', $('#apikey').value.trim());
  location.reload();
});

/* ------------------------------------------------------------------ live */

function connect() {
  const url = apiKey() ? `/api/events?key=${encodeURIComponent(apiKey())}` : '/api/events';
  const source = new EventSource(url);
  source.addEventListener('board', (e) => {
    board = JSON.parse(e.data);
    $('#live').classList.remove('off');
    render();
  });
  source.onerror = () => $('#live').classList.add('off');
}

(async function start() {
  board = await api('GET', '/api/board');
  render();
  connect();
})();
