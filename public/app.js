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
let filter = { text: '', assignee: '', label: '' };

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

// Defensive: an agent can PATCH any shape into the board over the API, and one
// bad field must not blank the whole UI.
const asArray = (v) => (Array.isArray(v) ? v : []);
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const safeColor = (v, fallback) => (typeof v === 'string' && HEX_COLOR.test(v.trim()) ? v.trim() : fallback);

// People render as initials on their colour — calm and readable at any size.
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '')).toUpperCase() || '?';
}

function avatarNode(assigneeId) {
  const agent = agentById(assigneeId);
  const node = el('div', 'avatar' + (agent ? '' : ' empty'));
  if (agent) {
    node.textContent = initials(agent.name);
    node.style.background = safeColor(agent.color, '#6b7ce0');
  }
  node.title = agent ? `${agent.name} (${agent.role})` : 'Unassigned';
  return node;
}

// Tiny monochrome glyphs for card metadata — static markup, never user input.
const GLYPHS = {
  check:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="3"/><path d="M5.2 8.3l2 2 3.6-4.4"/></svg>',
  comment:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 10a2 2 0 0 1-2 2H6.2L2.5 14.5V4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z"/></svg>',
};
function glyph(name) {
  const span = el('span', 'micon');
  span.innerHTML = GLYPHS[name];
  return span;
}

// Labels tint their chips from a fixed warm palette, picked by name hash so a
// label keeps its colour everywhere without anyone having to choose one.
const LABEL_TINTS = [
  { bg: '#e9ead6', fg: '#5c6132', dot: '#8a944e' },
  { bg: '#f5e7cd', fg: '#8a6420', dot: '#c9922e' },
  { bg: '#f6dfd9', fg: '#96493c', dot: '#cd6a56' },
  { bg: '#dde7ec', fg: '#3d6178', dot: '#5b8aa6' },
  { bg: '#dfeada', fg: '#48693f', dot: '#6d9861' },
  { bg: '#ebe0e9', fg: '#7b4a72', dot: '#a06a97' },
];
function labelTint(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 997;
  return LABEL_TINTS[hash % LABEL_TINTS.length];
}
function labelChip(name) {
  const tint = labelTint(name);
  const chip = el('span', 'label', String(name));
  chip.style.setProperty('--lbg', tint.bg);
  chip.style.setProperty('--lfg', tint.fg);
  return chip;
}

const filterActive = () => Boolean(filter.text || filter.assignee || filter.label);

function matchesFilter(card) {
  if (filter.assignee === '__none__') {
    if (card.assignee) return false;
  } else if (filter.assignee && card.assignee !== filter.assignee) {
    return false;
  }
  if (filter.label && !asArray(card.labels).includes(filter.label)) return false;
  if (filter.text) {
    const hay = `${card.title} ${card.description || ''} ${asArray(card.labels).join(' ')}`.toLowerCase();
    if (!hay.includes(filter.text)) return false;
  }
  return true;
}

function cardNode(card, column) {
  const node = el('div', `card ${card.status || 'open'}`);
  node.draggable = true;
  node.dataset.id = card.id;

  const labels = asArray(card.labels);
  if (labels.length) {
    const row = el('div', 'card-labels');
    for (const label of labels) row.appendChild(labelChip(label));
    node.appendChild(row);
  }

  node.appendChild(el('div', 'card-title', card.title));

  // Bottom row: date and progress on the left, the responsible person on the right.
  const meta = el('div', 'card-meta');
  if (card.status === 'done') {
    const finished = new Date(card.updatedAt || Date.now());
    meta.appendChild(
      el('span', 'done-date', `✓ ${finished.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`)
    );
  } else if (card.due) {
    meta.appendChild(el('span', 'due' + (isOverdue(card.due) ? ' overdue' : ''), formatDate(card.due)));
  }
  const checks = asArray(card.checklist);
  if (checks.length) {
    const badge = el('span', 'badge');
    badge.append(glyph('check'), document.createTextNode(`${checks.filter((c) => c && c.done).length}/${checks.length}`));
    meta.appendChild(badge);
  }
  const comments = asArray(card.comments);
  if (comments.length) {
    const badge = el('span', 'badge');
    badge.append(glyph('comment'), document.createTextNode(String(comments.length)));
    meta.appendChild(badge);
  }
  meta.appendChild(avatarNode(card.assignee));
  node.appendChild(meta);

  node.addEventListener('click', (e) => {
    if (e.target.closest('.avatar')) return; // the avatar is the assignee picker
    if (node.dataset.suppressClick) return; // a touch-drag just ended here
    openCard(card.id);
  });
  node.addEventListener('dragstart', (e) => {
    node.classList.add('dragging');
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));

  node.querySelector('.avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    openAssignMenu(card, e.currentTarget);
  });

  enableTouchDrag(node, card);
  return node;
}

/* ------------------------------------------- who is responsible (quick pick) */

function openAssignMenu(card, anchor) {
  const menu = $('#assign-menu');
  menu.innerHTML = '';
  menu.appendChild(el('div', 'head', 'Responsible'));

  const choose = (id) => {
    closeAssignMenu();
    api('PATCH', `/api/cards/${card.id}`, { assignee: id });
  };

  const none = el('button', 'assign-option' + (card.assignee ? '' : ' current'));
  none.append(el('div', 'avatar empty'), el('span', null, 'Unassigned'));
  none.addEventListener('click', () => choose(null));
  menu.appendChild(none);

  for (const agent of board.agents) {
    const option = el('button', 'assign-option' + (card.assignee === agent.id ? ' current' : ''));
    const av = el('div', 'avatar', initials(agent.name));
    av.style.background = safeColor(agent.color, '#6b7ce0');
    const who = el('div');
    who.appendChild(el('div', null, agent.name));
    who.appendChild(el('div', 'sub', agent.role));
    option.append(av, who);
    option.addEventListener('click', () => choose(agent.id));
    menu.appendChild(option);
  }

  menu.hidden = false;
  // Desktop: anchor to the avatar, nudged back on screen if it would overflow.
  const box = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  menu.style.top = `${Math.min(box.bottom + 6, window.innerHeight - size.height - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left - 170, window.innerWidth - size.width - 8))}px`;
  setTimeout(() => document.addEventListener('pointerdown', closeAssignMenuOnce, { once: true }), 0);
}

function closeAssignMenu() {
  $('#assign-menu').hidden = true;
}
function closeAssignMenuOnce(e) {
  if (e.target.closest('#assign-menu')) {
    document.addEventListener('pointerdown', closeAssignMenuOnce, { once: true });
    return;
  }
  closeAssignMenu();
}

/* -------------------------------------------------------- drag with a finger */

// HTML5 drag & drop never fires on touch screens, so on a phone the board would
// be read-only without this: press and hold a card, then drag it.
const LONG_PRESS_MS = 260;
const SLOP_PX = 10;

function enableTouchDrag(node, card) {
  let timer = null;
  let ghost = null;
  let start = null;
  let dragging = false;

  const cancelPress = () => {
    clearTimeout(timer);
    timer = null;
    node.classList.remove('press');
  };

  const begin = () => {
    dragging = true;
    node.classList.remove('press');
    node.classList.add('touch-source');
    // Mandatory scroll-snap yanks the board back to the current section, which
    // would make the edge-scroll below do nothing. Suspend it for the drag.
    $('#board').style.scrollSnapType = 'none';
    const box = node.getBoundingClientRect();
    ghost = node.cloneNode(true);
    ghost.classList.add('touch-ghost');
    ghost.classList.remove('touch-source');
    ghost.style.width = `${box.width}px`;
    document.body.appendChild(ghost);
    moveGhost(start.x, start.y);
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const moveGhost = (x, y) => {
    ghost.style.left = `${x - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${y - 28}px`;
  };

  node.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return; // mouse keeps native drag & drop
      if (e.target.closest('.avatar')) return;
      start = { x: e.clientX, y: e.clientY };
      node.classList.add('press');
      timer = setTimeout(begin, LONG_PRESS_MS);
    },
    { passive: true }
  );

  node.addEventListener(
    'pointermove',
    (e) => {
      if (!start) return;
      if (!dragging) {
        // Moved before the hold completed → the user is scrolling, not dragging.
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) cancelPress();
        return;
      }
      e.preventDefault(); // hold the page still while dragging
      moveGhost(e.clientX, e.clientY);
      highlightColumnAt(e.clientX, e.clientY);
      edgeScroll(e.clientX);
    },
    { passive: false }
  );

  const finish = (e) => {
    cancelPress();
    if (!dragging) {
      start = null;
      return;
    }
    dragging = false;
    start = null;
    ghost?.remove();
    ghost = null;
    node.classList.remove('touch-source');
    clearColumnHighlight();
    stopEdgeScroll();
    $('#board').style.scrollSnapType = '';

    // Suppress the click that follows the release, so we don't open the card.
    node.dataset.suppressClick = '1';
    setTimeout(() => delete node.dataset.suppressClick, 300);

    // Dropping onto a section tab is the reliable way to cross sections on a
    // phone — no scrolling, every section reachable, always visible.
    const tab = elementUnder(e.clientX, e.clientY)?.closest('.sectiontab');
    if (tab?.dataset.id) {
      api('PATCH', `/api/cards/${card.id}`, { columnId: tab.dataset.id });
      return;
    }

    // Otherwise the section it was released over, falling back to the one on
    // screen (released past the viewport edge, or over the topbar).
    const target = columnAt(e.clientX, e.clientY) || $(`.column[data-id="${activeSectionId()}"]`);
    if (!target) return;
    const column = board.columns.find((c) => c.id === target.dataset.id);
    if (!column) return;
    const position = dropPosition(target.querySelector('.col-body'), column, e.clientY, card.id);
    api('PATCH', `/api/cards/${card.id}`, { columnId: column.id, position });
  };

  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', () => {
    cancelPress();
    dragging = false;
    start = null;
    ghost?.remove();
    ghost = null;
    node.classList.remove('touch-source');
    clearColumnHighlight();
    stopEdgeScroll();
    $('#board').style.scrollSnapType = '';
  });
}

// The ghost sits under the finger, so hide it before asking what's underneath.
function elementUnder(x, y) {
  const ghost = document.querySelector('.touch-ghost');
  if (ghost) ghost.style.display = 'none';
  const under = document.elementFromPoint(x, y);
  if (ghost) ghost.style.display = '';
  return under;
}

function columnAt(x, y) {
  return elementUnder(x, y)?.closest('.column') || null;
}

function highlightColumnAt(x, y) {
  clearColumnHighlight();
  const under = elementUnder(x, y);
  const tab = under?.closest('.sectiontab');
  if (tab) return tab.classList.add('tab-over');
  under?.closest('.column')?.classList.add('touch-over');
}

function clearColumnHighlight() {
  document.querySelectorAll('.column.touch-over').forEach((c) => c.classList.remove('touch-over'));
  document.querySelectorAll('.sectiontab.tab-over').forEach((t) => t.classList.remove('tab-over'));
}

// Holding a dragged card near the screen edge pages to the neighbouring section.
// A rAF loop rather than setInterval: it stays in step with the compositor and
// isn't subject to timer throttling.
let edgeFrame = null;
let edgeDirection = 0;

function edgeScroll(x) {
  const near = 56;
  edgeDirection = x < near ? -1 : x > window.innerWidth - near ? 1 : 0;
  if (!edgeDirection) return stopEdgeScroll();
  if (edgeFrame) return;

  const step = () => {
    if (!edgeDirection) return stopEdgeScroll();
    const strip = $('#board');
    const before = strip.scrollLeft;
    strip.scrollLeft = before + edgeDirection * 12;
    // Hit the end of the board — nothing more to scroll towards.
    if (strip.scrollLeft === before) return stopEdgeScroll();
    edgeFrame = requestAnimationFrame(step);
  };
  edgeFrame = requestAnimationFrame(step);
}

function stopEdgeScroll() {
  if (edgeFrame) cancelAnimationFrame(edgeFrame);
  edgeFrame = null;
  edgeDirection = 0;
}

function columnNode(column) {
  const wrap = el('div', 'column');
  wrap.dataset.id = column.id;

  const head = el('div', 'col-head');
  head.style.setProperty('--c', safeColor(column.color, '#9aa1b0'));
  const title = el('span', 'title', column.title);
  head.appendChild(title);
  const cards = asArray(column.cards);
  const visible = cards.filter(matchesFilter);
  head.appendChild(el('span', 'count', filterActive() ? `${visible.length}/${cards.length}` : String(cards.length)));

  // double-click the header to rename, right-click to recolor / delete
  head.addEventListener('dblclick', () => {
    if (head.querySelector('input')) return; // already renaming; a second dblclick would throw
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
    api('PATCH', `/api/columns/${column.id}`, { color: color.trim() });
  });

  const body = el('div', 'col-body');
  for (const card of visible) body.appendChild(cardNode(card, column));

  const add = el('button', 'add-card', '+ Add task');
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
    const position = dropPosition(body, column, e.clientY, cardId);
    api('PATCH', `/api/cards/${cardId}`, { columnId: column.id, position });
  });

  wrap.append(head, body);
  return wrap;
}

// Where in the column did the pointer land? The answer has to be an index into
// the FULL card array, while only the filtered cards are on screen — so find the
// rendered card the drop lands above, then look up where that one really sits.
function dropPosition(body, column, y, draggedId) {
  const rendered = [...body.querySelectorAll('.card')].filter((c) => c.dataset.id !== draggedId);
  const full = asArray(column.cards).filter((c) => c.id !== draggedId);

  let beforeId = null;
  for (const node of rendered) {
    const box = node.getBoundingClientRect();
    if (y < box.top + box.height / 2) {
      beforeId = node.dataset.id;
      break;
    }
  }
  if (beforeId === null) return full.length; // dropped below every visible card
  const index = full.findIndex((c) => c.id === beforeId);
  return index === -1 ? full.length : index;
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
  const root = $('#board');
  const scroll = root.scrollLeft;
  // Agents act constantly; a re-render must not yank every column back to the top.
  const scrollTops = new Map(
    [...root.querySelectorAll('.column')].map((c) => [c.dataset.id, c.querySelector('.col-body')?.scrollTop || 0])
  );

  root.innerHTML = '';
  for (const column of board.columns) {
    const node = columnNode(column);
    root.appendChild(node);
    const previous = scrollTops.get(column.id);
    if (previous) node.querySelector('.col-body').scrollTop = previous;
  }

  const addCol = el('button', 'add-column', '+ Section');
  addCol.title = 'Add section';
  addCol.addEventListener('click', addSection);
  root.appendChild(addCol);
  root.scrollLeft = scroll;

  $('#board-title').textContent = board.title || 'Workforce';
  const open = board.columns.reduce(
    (n, c) => n + asArray(c.cards).filter((card) => card.status !== 'done').length,
    0
  );
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  $('#page-meta').textContent = `${open} open task${open === 1 ? '' : 's'} · week of ${today}`;

  renderSectionTabs();
  renderWorkload();
  renderLabels();
  if (openCardId && !$('#drawer').hidden) renderDrawer();
  if (!$('#team').hidden) renderTeam();
  if (!$('#activity').hidden) renderActivity();
}

// On a phone one section fills the screen, so the tab strip is how you move
// between them (and shows the counts you'd otherwise lose).
function renderSectionTabs() {
  const strip = $('#sectiontabs');
  strip.innerHTML = '';
  for (const column of board.columns) {
    const tab = el('button', 'sectiontab');
    tab.style.setProperty('--c', safeColor(column.color, '#9aa1b0'));
    tab.dataset.id = column.id;
    tab.append(el('span', 't', column.title), el('span', 'n', String(asArray(column.cards).length)));
    tab.addEventListener('click', () => {
      const node = $(`.column[data-id="${column.id}"]`);
      // Scroll the board itself, never scrollIntoView — that can scroll ancestors
      // too and fight the board's own scroll handler.
      if (node) $('#board').scrollTo({ left: node.offsetLeft, behavior: 'smooth' });
      markActiveTab(column.id);
    });
    strip.appendChild(tab);
  }

  const add = el('button', 'sectiontab add', '+');
  add.addEventListener('click', addSection);
  strip.appendChild(add);

  markActiveTab(activeSectionId());
}

function activeSectionId() {
  const root = $('#board');
  const columns = [...root.querySelectorAll('.column')];
  const hit = columns.find((c) => c.offsetLeft + c.offsetWidth > root.scrollLeft + 10);
  return hit?.dataset.id || board.columns[0]?.id;
}

function markActiveTab(id) {
  document.querySelectorAll('.sectiontab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
  const strip = $('#sectiontabs');
  const active = strip.querySelector('.sectiontab.active');
  if (!active) return;
  // Nudge the strip only, and only when the active tab is actually out of view.
  const left = active.offsetLeft - strip.offsetLeft;
  const right = left + active.offsetWidth;
  if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 12);
  else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 12;
}

async function addSection() {
  const title = prompt('Section name');
  if (!title) return;
  const palette = ['#3d4451', '#f5c343', '#f0a441', '#ec5f8f', '#e2504f', '#4bc07a', '#9b7bd4', '#4f8ef7'];
  await api('POST', '/api/columns', { title, color: palette[board.columns.length % palette.length] });
}

// The strip under the topbar: who has how many open tasks. Clicking a person
// filters the board to their cards; clicking again clears the filter.
function renderWorkload() {
  const strip = $('#workload');
  strip.innerHTML = '';

  const load = {};
  let unassigned = 0;
  let total = 0;
  for (const column of board.columns) {
    for (const card of asArray(column.cards)) {
      if (card.status === 'done') continue; // finished work isn't workload
      total++;
      if (card.assignee) load[card.assignee] = (load[card.assignee] || 0) + 1;
      else unassigned++;
    }
  }

  const chip = (label, count, value, avatar) => {
    const node = el('button', 'wchip' + (filter.assignee === value ? ' active' : ''));
    if (avatar) node.appendChild(avatar);
    node.append(el('span', 'wname', label), el('span', 'wcount', String(count)));
    node.addEventListener('click', () => {
      filter.assignee = filter.assignee === value ? '' : value;
      render();
    });
    return node;
  };

  strip.appendChild(chip('Everyone', total, ''));
  for (const agent of board.agents) {
    const av = el('span', 'wavatar', initials(agent.name));
    av.style.background = safeColor(agent.color, '#9a988c');
    strip.appendChild(chip(agent.name, load[agent.id] || 0, agent.id, av));
  }
  if (unassigned) strip.appendChild(chip('Unassigned', unassigned, '__none__', el('span', 'wavatar empty')));
}

// The sidebar's label list: every distinct label in use, tinted like its chips.
// Clicking filters the board to that label; clicking again clears.
function renderLabels() {
  const list = $('#labels');
  list.innerHTML = '';
  const seen = new Set();
  for (const column of board.columns)
    for (const card of asArray(column.cards)) for (const label of asArray(card.labels)) seen.add(String(label));

  const names = [...seen].sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    list.appendChild(el('div', 'muted small', 'No labels yet'));
    return;
  }
  for (const name of names) {
    const chip = el('button', 'lchip' + (filter.label === name ? ' active' : ''));
    chip.style.setProperty('--c', labelTint(name).dot);
    chip.appendChild(el('span', 'lname', name));
    chip.addEventListener('click', () => {
      filter.label = filter.label === name ? '' : name;
      render();
    });
    list.appendChild(chip);
  }
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
  chip.textContent = column.title;
  chip.style.setProperty('--c', safeColor(column.color, '#9aa1b0'));

  if (!editing) {
    $('#d-title').value = card.title;
    $('#d-desc').value = card.description || '';
    $('#d-due').value = card.due || '';
    $('#d-labels').value = asArray(card.labels).join(', ');
  }

  const assignee = $('#d-assignee');
  assignee.innerHTML = '<option value="">Unassigned</option>';
  for (const agent of board.agents) {
    const opt = el('option', null, `${agent.name} — ${agent.role}`);
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
  asArray(card.checklist).forEach((item, i) => {
    const li = el('li', item && item.done ? 'done' : '');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!(item && item.done);
    // Read the checklist at click time, not at render time: two quick ticks
    // would otherwise both patch the same stale array and undo each other.
    box.addEventListener('change', () =>
      patchChecklist((items) => items.map((c, j) => (j === i ? { ...c, done: box.checked } : c)))
    );
    const remove = el('button', 'icon-btn', '✕');
    remove.addEventListener('click', () => patchChecklist((items) => items.filter((_, j) => j !== i)));
    li.append(box, el('span', null, item && item.text ? item.text : ''), remove);
    list.appendChild(li);
  });

  const comments = $('#d-comments');
  comments.innerHTML = '';
  for (const c of asArray(card.comments)) {
    const node = el('div', 'comment');
    const head = el('div');
    const agent = agentById(c.author);
    head.appendChild(el('span', 'who', agent ? agent.name : c.author));
    head.appendChild(el('span', 'when', formatTime(c.ts)));
    node.append(head, el('div', 'text', c.text));
    comments.appendChild(node);
  }
  if (!asArray(card.comments).length) comments.appendChild(el('div', 'muted small', 'No messages yet.'));

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

// Always derives the new checklist from the CURRENT board state.
function patchChecklist(transform) {
  const hit = locate(openCardId);
  if (!hit) return;
  const next = transform(asArray(hit.card.checklist));
  hit.card.checklist = next; // optimistic, so a second edit before the SSE frame sees it
  api('PATCH', `/api/cards/${hit.card.id}`, { checklist: next });
}

/* ------------------------------------------------------------ side panels */

function renderTeam() {
  const list = $('#team-list');
  list.innerHTML = '';
  const load = {};
  for (const column of board.columns)
    for (const card of asArray(column.cards))
      if (card.assignee && card.status !== 'done') load[card.assignee] = (load[card.assignee] || 0) + 1;

  for (const agent of board.agents) {
    const row = el('div', 'team-row');
    const av = el('div', 'avatar', initials(agent.name));
    av.style.background = safeColor(agent.color, '#6b7ce0');
    const info = el('div');
    info.style.flex = '1';
    info.appendChild(el('div', 'who', agent.name));
    info.appendChild(
      el('div', 'sub', `${agent.role} · ${load[agent.id] || 0} open · ${(agent.skills || []).join(', ') || 'no skills listed'}`)
    );
    const beMe = el('button', 'ghost small', me() === agent.id ? 'you' : 'act as');
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
    line.appendChild(el('span', 'who', agent ? agent.name : act.actor));
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

// 'YYYY-MM-DD' parsed by `new Date()` is treated as UTC midnight, which renders
// a day early for anyone west of UTC — parse the parts as a local date instead.
function parseDay(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function isOverdue(iso) {
  const today = new Date();
  return parseDay(iso) < new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

function formatDate(iso) {
  const date = parseDay(iso);
  const options = { day: 'numeric', month: 'short' };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(undefined, options);
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
// "+ New task" opens the composer in the section currently on screen.
$('#btn-new').addEventListener('click', () => {
  const target = $(`.column[data-id="${activeSectionId()}"] .add-card`) || $('.column .add-card');
  target?.click();
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

// Keep the tab strip in step with a sideways swipe.
let tabSyncTimer = null;
$('#board').addEventListener(
  'scroll',
  () => {
    clearTimeout(tabSyncTimer);
    tabSyncTimer = setTimeout(() => markActiveTab(activeSectionId()), 60);
  },
  { passive: true }
);
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
  if (!text || !openCardId) return;
  input.value = '';
  patchChecklist((items) => [...items, { text, done: false }]);
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
    role: $('#a-role').value.trim() || 'agent',
  });
  ['#a-id', '#a-name', '#a-role'].forEach((s) => ($(s).value = ''));
});
$('#apikey-save').addEventListener('click', () => {
  localStorage.setItem('workforce_key', $('#apikey').value.trim());
  location.reload();
});

/* ------------------------------------------------------------------ live */

// EventSource retries transient drops itself, but a 401/404 or an HTML error page
// (Replit serves one while a sleeping container wakes) closes it for good. Without
// this loop the board silently freezes for the life of the tab.
let source = null;
let retryDelay = 1000;

function connect() {
  if (source) source.close();
  const url = apiKey() ? `/api/events?key=${encodeURIComponent(apiKey())}` : '/api/events';
  source = new EventSource(url);

  source.addEventListener('board', (e) => {
    try {
      board = JSON.parse(e.data);
    } catch {
      return;
    }
    retryDelay = 1000;
    $('#live').classList.remove('off');
    render();
  });

  source.onerror = () => {
    $('#live').classList.add('off');
    if (source.readyState !== EventSource.CLOSED) return; // it will retry on its own
    source.close();
    const wait = retryDelay + Math.floor(Math.random() * 500);
    retryDelay = Math.min(retryDelay * 2, 30000);
    setTimeout(reconnect, wait);
  };
}

async function reconnect() {
  try {
    // Re-fetch outright: frames sent while we were disconnected are gone.
    board = await api('GET', '/api/board');
    render();
  } catch {
    /* connect() below will keep retrying */
  }
  connect();
}

// A sleeping tab that wakes up should catch up immediately rather than wait out the backoff.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && source && source.readyState === EventSource.CLOSED) reconnect();
});

(async function start() {
  board = await api('GET', '/api/board');
  render();
  connect();
})();
