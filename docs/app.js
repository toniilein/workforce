/*
 * Board — the GitHub Pages build.
 *
 * No server. Each task is a .md file in the repo's tasks/ folder; this page
 * lists them through GitHub's API, parses the frontmatter, and renders the
 * board. Connect a token (sidebar) and it becomes interactive: dragging a card
 * or editing it rewrites that file and commits. The repo IS the database, and
 * every change is a commit you can see in the history.
 */

const REPO = { owner: 'toniilein', name: 'workforce', branch: 'main', dir: 'tasks' };

const SECTIONS = [
  { id: 'todo', title: 'Todo', color: '#3d4451' },
  { id: 'doing', title: 'Doing', color: '#4f8ef7' },
  { id: 'blocked', title: 'Blocked', color: '#e2504f' },
  { id: 'review', title: 'Review', color: '#f59e0b' },
  { id: 'done', title: 'Done', color: '#4bc07a' },
];

// Known people. Anyone else named in a file still appears, in grey.
const PEOPLE = {
  toni: { name: 'Toni', color: '#2f3542' },
  Adi: { name: 'Adi', color: '#6b7ce0' },
  '007': { name: 'Pookachu Bot', color: '#5b8aa6' },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// Bind defensively. Pages caches HTML and JS separately, so a deploy can briefly
// pair new JS with old HTML; without this, one missing element throws and takes
// the whole board down instead of just disabling one button.
function on(sel, event, handler) {
  const node = $(sel);
  if (node) node.addEventListener(event, handler);
  else console.warn(`missing element ${sel} — reload if the page is mid-update`);
}

let tasks = [];
let filter = { text: '', assignee: '', label: '' };
let openFile = null;
let busy = false;
let permissionProblem = false; // token connected but GitHub refused a write

/* ------------------------------------------------------------------ notices */

// alert() blocks the whole page (it froze the board once), so notices are
// in-page and non-blocking.
function toast(message, kind = 'info') {
  const node = el('div', `toast ${kind}`, message);
  const host = $('#toasts');
  if (!host) return console.warn('toast:', message);
  host.appendChild(node);
  setTimeout(() => node.classList.add('leaving'), kind === 'error' ? 6000 : 2500);
  setTimeout(() => node.remove(), kind === 'error' ? 6400 : 2900);
}

/* ------------------------------------------------------------------ github */

const editUrl = (file) =>
  `https://github.com/${REPO.owner}/${REPO.name}/edit/${REPO.branch}/${REPO.dir}/${encodeURIComponent(file)}`;

async function loadTasks() {
  const listUrl = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${REPO.dir}?ref=${REPO.branch}`;
  const files = (await ghFetch(listUrl)).filter(
    (f) => f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md'
  );

  const bust = Date.now(); // raw CDN caches for minutes; Refresh must really refresh
  const loaded = await Promise.all(
    files.map(async (f) => {
      const text = await fetch(`${f.download_url}?t=${bust}`).then((r) => (r.ok ? r.text() : ''));
      return { ...parseTask(f.name, text), sha: f.sha };
    })
  );
  return loaded.sort((a, b) => a.title.localeCompare(b.title));
}

/* ----------------------------------------------------------- markdown <-> task */

function parseTask(file, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  const meta = {};
  let body = text.trim();

  if (match) {
    body = match[2].trim();
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at === -1) continue;
      meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }

  const status = (meta.status || 'todo').toLowerCase();
  return {
    file,
    title: meta.title || file.replace(/\.md$/, '').replace(/[-_]/g, ' '),
    status: SECTIONS.some((s) => s.id === status) ? status : 'todo',
    assignee: meta.assignee || '',
    due: /^\d{4}-\d{2}-\d{2}$/.test(meta.due || '') ? meta.due : '',
    labels: (meta.labels || '').split(',').map((s) => s.trim()).filter(Boolean),
    body,
  };
}

function toMarkdown(task) {
  return [
    '---',
    `title: ${task.title}`,
    `status: ${task.status}`,
    `assignee: ${task.assignee || ''}`,
    `due: ${task.due || ''}`,
    `labels: ${task.labels.join(', ')}`,
    '---',
    '',
    task.body || '',
    '',
  ].join('\n');
}

// Every mutation goes through here: rewrite the file, commit, update in place.
async function saveTask(task, message) {
  if (!gh.connected) throw new Error('Connect a GitHub token to make changes.');
  setBusy(true);
  try {
    const res = await putFile(REPO, `${REPO.dir}/${task.file}`, toMarkdown(task), message, task.sha);
    task.sha = res.content.sha; // keep the new sha or the next save 409s
    render();
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  busy = on;
  document.body.classList.toggle('busy', on);
  $('#page-meta').textContent = on ? 'Saving to GitHub…' : metaLine();
}

/* ---------------------------------------------------------------- rendering */

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '')).toUpperCase() || '?';
}
const personName = (id) => PEOPLE[id]?.name || id;
const personColor = (id) => PEOPLE[id]?.color || '#9a988c';

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

const parseDay = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const isOverdue = (iso) => {
  const t = new Date();
  return parseDay(iso) < new Date(t.getFullYear(), t.getMonth(), t.getDate());
};
function formatDate(iso) {
  const date = parseDay(iso);
  const opts = { day: 'numeric', month: 'short' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

function matchesFilter(task) {
  if (filter.assignee === '__none__') {
    if (task.assignee) return false;
  } else if (filter.assignee && task.assignee !== filter.assignee) return false;
  if (filter.label && !task.labels.includes(filter.label)) return false;
  if (filter.text && !`${task.title} ${task.body}`.toLowerCase().includes(filter.text)) return false;
  return true;
}

function cardNode(task) {
  const card = el('div', `card ${task.status}`);
  card.dataset.file = task.file;
  card.draggable = gh.connected;
  card.title = gh.connected ? 'Click to edit · drag to move' : 'Click to open on GitHub';

  if (task.labels.length) {
    const row = el('div', 'card-labels');
    for (const name of task.labels) {
      const tint = labelTint(name);
      const chip = el('span', 'label', name);
      chip.style.setProperty('--lbg', tint.bg);
      chip.style.setProperty('--lfg', tint.fg);
      row.appendChild(chip);
    }
    card.appendChild(row);
  }

  card.appendChild(el('div', 'card-title', task.title));

  const meta = el('div', 'card-meta');
  if (task.due && task.status !== 'done')
    meta.appendChild(el('span', 'due' + (isOverdue(task.due) ? ' overdue' : ''), formatDate(task.due)));

  const avatar = el('div', 'avatar' + (task.assignee ? '' : ' empty'));
  if (task.assignee) {
    avatar.textContent = initials(personName(task.assignee));
    avatar.style.background = personColor(task.assignee);
    avatar.title = personName(task.assignee);
  } else {
    avatar.title = 'Unassigned';
  }
  meta.appendChild(avatar);
  card.appendChild(meta);

  card.addEventListener('click', () => {
    if (card.dataset.suppressClick) return;
    if (gh.connected) openDrawer(task.file);
    else window.open(editUrl(task.file), '_blank', 'noopener');
  });

  if (gh.connected) {
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', task.file);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    enableTouchDrag(card, task);
  }
  return card;
}

function render() {
  const board = $('#board');
  board.innerHTML = '';

  for (const section of SECTIONS) {
    const wrap = el('div', 'column');
    wrap.dataset.status = section.id;

    const head = el('div', 'col-head');
    head.style.setProperty('--c', section.color);
    head.append(el('span', 'title', section.title));
    const visible = tasks.filter((t) => t.status === section.id && matchesFilter(t));
    head.appendChild(el('span', 'count', String(visible.length)));

    const body = el('div', 'col-body');
    for (const task of visible) body.appendChild(cardNode(task));

    const add = el('button', 'add-card', '+ Add task');
    add.addEventListener('click', () => startNewCard(section.id, body, add));
    body.appendChild(add);

    if (gh.connected) {
      body.addEventListener('dragover', (e) => {
        e.preventDefault();
        wrap.classList.add('drop-target');
      });
      body.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
      body.addEventListener('drop', (e) => {
        e.preventDefault();
        wrap.classList.remove('drop-target');
        moveTask(e.dataTransfer.getData('text/plain'), section.id);
      });
    }

    wrap.append(head, body);
    board.appendChild(wrap);
  }

  renderWorkload();
  renderLabels();
  renderSectionTabs();
  renderConnection();
  if (openFile && !$('#drawer').hidden) renderDrawer();
  if (!busy) $('#page-meta').textContent = metaLine();
}

function metaLine() {
  const open = tasks.filter((t) => t.status !== 'done').length;
  const mode = gh.connected ? 'connected' : 'read-only';
  return `${open} open task${open === 1 ? '' : 's'} · ${tasks.length} files · ${mode}`;
}

function renderWorkload() {
  const strip = $('#workload');
  strip.innerHTML = '';
  const load = {};
  let unassigned = 0;
  for (const task of tasks) {
    if (task.status === 'done') continue;
    if (task.assignee) load[task.assignee] = (load[task.assignee] || 0) + 1;
    else unassigned++;
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

  strip.appendChild(chip('Everyone', tasks.filter((t) => t.status !== 'done').length, ''));
  const ids = new Set([...Object.keys(PEOPLE), ...tasks.map((t) => t.assignee).filter(Boolean)]);
  for (const id of ids) {
    const av = el('span', 'wavatar', initials(personName(id)));
    av.style.background = personColor(id);
    strip.appendChild(chip(personName(id), load[id] || 0, id, av));
  }
  if (unassigned) strip.appendChild(chip('Unassigned', unassigned, '__none__', el('span', 'wavatar empty')));
}

function renderLabels() {
  const list = $('#labels');
  list.innerHTML = '';
  const names = [...new Set(tasks.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b));
  if (!names.length) return list.appendChild(el('div', 'muted small', 'No labels yet'));
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

function renderSectionTabs() {
  const strip = $('#sectiontabs');
  strip.innerHTML = '';
  SECTIONS.forEach((section, i) => {
    const count = tasks.filter((t) => t.status === section.id && matchesFilter(t)).length;
    const tab = el('button', 'sectiontab' + (i === 0 ? ' active' : ''));
    tab.style.setProperty('--c', section.color);
    tab.dataset.status = section.id;
    tab.append(el('span', 't', section.title), el('span', 'n', String(count)));
    tab.addEventListener('click', () => {
      const node = document.querySelectorAll('.column')[i];
      if (node) $('#board').scrollTo({ left: node.offsetLeft, behavior: 'smooth' });
      document.querySelectorAll('.sectiontab').forEach((t) => t.classList.toggle('active', t === tab));
    });
    strip.appendChild(tab);
  });
}

function renderConnection() {
  const btn = $('#btn-connect');
  if (btn) btn.textContent = gh.connected ? 'GitHub token' : 'Connect GitHub';

  const banner = $('#banner');
  const text = $('#banner-text');
  const connect = $('#banner-connect');
  const help = $('#banner-help');
  if (!banner || !text || !connect) return;

  if (permissionProblem) {
    banner.hidden = false;
    banner.classList.add('error');
    text.innerHTML =
      "<strong>Your token can read but not write.</strong> On the token page open it, set " +
      "<strong>Permissions → Contents → Read and write</strong> (and make sure <strong>workforce</strong> " +
      'is among its repositories), save, then reconnect with the updated token.';
    connect.textContent = 'Reconnect';
    help.hidden = false;
  } else if (!gh.connected) {
    banner.hidden = false;
    banner.classList.remove('error');
    text.innerHTML =
      '<strong>Read-only.</strong> Connect GitHub to drag cards and edit them — changes are saved as commits in your repo.';
    connect.textContent = 'Connect GitHub';
    help.hidden = false;
  } else {
    banner.hidden = true;
  }

  const live = $('#live');
  live.classList.toggle('off', !gh.connected || permissionProblem);
  live.title = permissionProblem
    ? 'Connected, but the token cannot write'
    : gh.connected
      ? 'Connected — changes commit to the repo'
      : 'Read-only — connect a token to edit';
}

/* ------------------------------------------------------------------ actions */

const byFile = (file) => tasks.find((t) => t.file === file);

// A write failed: surface it where it can be acted on, not in a popup.
function reportWriteFailure(err) {
  if (/permission|read but not write/i.test(err.message)) {
    permissionProblem = true;
    renderConnection();
    toast('GitHub refused the change — see the note above the board.', 'error');
  } else {
    toast(err.message, 'error');
  }
}

async function moveTask(file, status) {
  const task = byFile(file);
  if (!task || task.status === status) return;
  const from = task.status;
  task.status = status;
  render();
  try {
    await saveTask(task, `task: ${task.file.replace(/\.md$/, '')} → ${status}`);
    permissionProblem = false;
  } catch (err) {
    task.status = from; // put it back where it was
    render();
    reportWriteFailure(err);
  }
}

// Inline composer in the column — no browser prompt.
function startNewCard(status, body, addBtn) {
  if (body.querySelector('.new-card-input')) return;
  const input = el('textarea', 'new-card-input');
  input.rows = 2;
  input.placeholder = 'Task title — Enter to save, Esc to cancel';
  body.insertBefore(input, addBtn);
  input.focus();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const title = input.value.trim();
    input.remove();
    if (save && title) await createTask(status, title);
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function createTask(status, title) {
  if (!gh.connected) {
    toast('Connect GitHub first — the board is read-only.', 'error');
    render();
    return;
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';
  let file = `${slug}.md`;
  let n = 2;
  while (byFile(file)) file = `${slug}-${n++}.md`;

  const task = { file, title, status, assignee: '', due: '', labels: [], body: '', sha: null };
  tasks.push(task); // optimistic, so the card appears immediately
  render();
  setBusy(true);
  try {
    const res = await putFile(REPO, `${REPO.dir}/${file}`, toMarkdown(task), `task: add ${slug}`);
    task.sha = res.content.sha;
    permissionProblem = false;
    toast('Task created');
  } catch (err) {
    tasks = tasks.filter((t) => t !== task); // roll back the card
    reportWriteFailure(err);
  } finally {
    setBusy(false);
    render();
  }
}

// Two-step delete instead of confirm(), which also blocks the page.
let pendingDelete = null;
function requestDelete(file) {
  const btn = $('#d-delete');
  if (pendingDelete !== file) {
    pendingDelete = file;
    btn.textContent = 'Tap again to delete';
    btn.classList.add('armed');
    setTimeout(() => {
      if (pendingDelete === file) {
        pendingDelete = null;
        btn.textContent = 'Delete task';
        btn.classList.remove('armed');
      }
    }, 4000);
    return;
  }
  pendingDelete = null;
  btn.textContent = 'Delete task';
  btn.classList.remove('armed');
  removeTask(file);
}

async function removeTask(file) {
  const task = byFile(file);
  if (!task) return;
  setBusy(true);
  try {
    await deleteFile(REPO, `${REPO.dir}/${file}`, `task: remove ${file.replace(/\.md$/, '')}`, task.sha);
    tasks = tasks.filter((t) => t.file !== file);
    permissionProblem = false;
    closeDrawer();
    toast('Task deleted');
  } catch (err) {
    reportWriteFailure(err);
  } finally {
    setBusy(false);
    render();
  }
}

/* ------------------------------------------------------------------ drawer */

function openDrawer(file) {
  openFile = file;
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  renderDrawer();
}

function closeDrawer() {
  openFile = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

function renderDrawer() {
  const task = byFile(openFile);
  if (!task) return closeDrawer();
  const focused = document.activeElement;
  const editing = focused && $('#drawer').contains(focused) && /INPUT|TEXTAREA|SELECT/.test(focused.tagName);

  const section = SECTIONS.find((s) => s.id === task.status);
  const chip = $('#drawer-section');
  chip.textContent = section?.title || task.status;
  chip.style.setProperty('--c', section?.color || '#9a988c');

  if (!editing) {
    $('#d-title').value = task.title;
    $('#d-desc').value = task.body;
    $('#d-due').value = task.due;
    $('#d-labels').value = task.labels.join(', ');
  }

  const assignee = $('#d-assignee');
  assignee.innerHTML = '<option value="">Unassigned</option>';
  const ids = new Set([...Object.keys(PEOPLE), ...(task.assignee ? [task.assignee] : [])]);
  for (const id of ids) {
    const opt = el('option', null, personName(id));
    opt.value = id;
    assignee.appendChild(opt);
  }
  assignee.value = task.assignee;

  const status = $('#d-status');
  status.innerHTML = '';
  for (const s of SECTIONS) {
    const opt = el('option', null, s.title);
    opt.value = s.id;
    status.appendChild(opt);
  }
  status.value = task.status;

  $('#d-file').textContent = `${REPO.dir}/${task.file}`;
  $('#d-github').href = editUrl(task.file);
}

function patchOpen(change, message) {
  const task = byFile(openFile);
  if (!task) return;
  const before = { ...task };
  Object.assign(task, change);
  render();
  saveTask(task, message)
    .then(() => {
      permissionProblem = false;
    })
    .catch((err) => {
      Object.assign(task, before); // undo the edit we couldn't save
      render();
      reportWriteFailure(err);
    });
}

/* -------------------------------------------------------- drag with a finger */

const LONG_PRESS_MS = 260;
function enableTouchDrag(node, task) {
  let timer = null;
  let ghost = null;
  let start = null;
  let dragging = false;

  const cancel = () => {
    clearTimeout(timer);
    node.classList.remove('press');
  };

  node.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return;
      start = { x: e.clientX, y: e.clientY };
      node.classList.add('press');
      timer = setTimeout(() => {
        dragging = true;
        node.classList.remove('press');
        node.classList.add('touch-source');
        $('#board').style.scrollSnapType = 'none';
        ghost = node.cloneNode(true);
        ghost.classList.add('touch-ghost');
        ghost.style.width = `${node.getBoundingClientRect().width}px`;
        document.body.appendChild(ghost);
        moveGhost(start.x, start.y);
        navigator.vibrate?.(8);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );

  const moveGhost = (x, y) => {
    ghost.style.left = `${x - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${y - 28}px`;
  };

  node.addEventListener(
    'pointermove',
    (e) => {
      if (!start) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
        return;
      }
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
      highlightAt(e.clientX, e.clientY);
    },
    { passive: false }
  );

  const finish = (e) => {
    cancel();
    if (!dragging) return (start = null);
    dragging = false;
    start = null;
    ghost?.remove();
    ghost = null;
    node.classList.remove('touch-source');
    clearHighlight();
    $('#board').style.scrollSnapType = '';
    node.dataset.suppressClick = '1';
    setTimeout(() => delete node.dataset.suppressClick, 300);

    const under = elementUnder(e.clientX, e.clientY);
    const status = under?.closest('.sectiontab')?.dataset.status || under?.closest('.column')?.dataset.status;
    if (status) moveTask(task.file, status);
  };

  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);
}

function elementUnder(x, y) {
  const ghost = document.querySelector('.touch-ghost');
  if (ghost) ghost.style.display = 'none';
  const under = document.elementFromPoint(x, y);
  if (ghost) ghost.style.display = '';
  return under;
}
function highlightAt(x, y) {
  clearHighlight();
  const under = elementUnder(x, y);
  const tab = under?.closest('.sectiontab');
  if (tab) return tab.classList.add('tab-over');
  under?.closest('.column')?.classList.add('touch-over');
}
function clearHighlight() {
  document.querySelectorAll('.touch-over').forEach((n) => n.classList.remove('touch-over'));
  document.querySelectorAll('.tab-over').forEach((n) => n.classList.remove('tab-over'));
}

/* ------------------------------------------------------------------ wiring */

on('#search', 'input', (e) => {
  filter.text = e.target.value.trim().toLowerCase();
  render();
});
on('#btn-refresh', 'click', () => start());
on('#btn-new', 'click', () => createTask('todo'));
const repoLink = $('#repo-link');
if (repoLink) repoLink.href = `https://github.com/${REPO.owner}/${REPO.name}/tree/${REPO.branch}/${REPO.dir}`;

// Shows what is actually stored, so the token has a visible home rather than
// being an invisible thing you re-enter and hope about.
function renderTokenStatus() {
  const box = $('#token-status');
  if (!box) return;
  box.hidden = !gh.connected;
  if (!gh.connected) return;

  box.classList.toggle('bad', permissionProblem);
  const state = $('#token-state');
  const value = $('#token-value');
  const saved = $('#token-saved');
  if (state) state.textContent = permissionProblem ? 'Saved, but it cannot write' : 'Saved and working';
  if (value) value.textContent = gh.masked;
  if (saved) {
    const when = gh.savedAt ? new Date(gh.savedAt) : null;
    saved.textContent = when
      ? `Stored in this browser since ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      : 'Stored in this browser';
  }
}

function openTokenModal() {
  const input = $('#token-input');
  const modal = $('#token-modal');
  if (!modal || !input) return;
  input.value = '';
  const err = $('#token-error');
  if (err) err.hidden = true;

  renderTokenStatus();
  // Replacing a saved token has to be possible without disconnecting first —
  // otherwise a broken token locks you out of entering a working one.
  const remove = $('#token-disconnect');
  if (remove) remove.hidden = !gh.connected;
  const howto = $('#token-howto');
  if (howto) howto.open = !gh.connected; // steps expanded only when there's nothing saved
  const save = $('#token-save');
  if (save) save.textContent = gh.connected ? 'Replace token' : 'Save token';

  modal.hidden = false;
  if (!gh.connected) input.focus();
}

// Proves the stored token still works, from the panel, without touching a card.
async function testToken() {
  const btn = $('#token-test');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Testing…';
  }
  try {
    await checkAccess(REPO);
    // A read succeeding says nothing about writing, so try a real (harmless)
    // write: rewrite one task file with its own current content.
    const probe = tasks[0];
    if (probe) {
      await putFile(REPO, `${REPO.dir}/${probe.file}`, toMarkdown(probe), 'task: verify write access', probe.sha)
        .then((res) => {
          probe.sha = res.content.sha;
        });
    }
    permissionProblem = false;
    toast('Token works — reading and writing.');
  } catch (err) {
    if (/permission|read but not write/i.test(err.message)) permissionProblem = true;
    toast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Test it';
    }
    renderTokenStatus();
    renderConnection();
  }
}

function closeTokenModal() {
  const modal = $('#token-modal');
  if (modal) modal.hidden = true;
}

// Always opens the dialog; disconnecting lives inside it.
function connectGitHub() {
  openTokenModal();
}

function disconnectGitHub() {
  gh.token = '';
  permissionProblem = false;
  closeTokenModal();
  render();
  toast('Token removed — the board is read-only again.');
}

// Ask the browser's password manager to remember the token, so other devices
// that sync with it fill it in instead of you retyping. Chromium implements
// this explicitly; elsewhere the form markup lets the manager offer it itself.
// Browsers evict "best effort" storage under pressure, and Safari clears
// script-written storage on sites you haven't opened for a week — which would
// silently log the board out. Asking for persistent storage exempts it.
async function keepStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* not supported — nothing lost, storage is just best-effort */
  }
}

async function offerToRemember(token) {
  try {
    if (!window.PasswordCredential || !navigator.credentials?.store) return;
    const credential = new window.PasswordCredential({
      id: `${REPO.owner}/${REPO.name}`,
      password: token,
      name: 'Board — GitHub token',
    });
    await navigator.credentials.store(credential);
  } catch {
    /* the manager declined or is unavailable — the form fallback still applies */
  }
}

async function saveToken() {
  const input = $('#token-input');
  const err = $('#token-error');
  const token = input.value.trim();
  if (!token) return;

  const previous = gh.token;
  gh.token = token;
  const saveBtn = $('#token-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    await checkAccess(REPO);
    // The repo endpoint reports OUR access, not the token's, so it cannot prove
    // the token may write. The first real save is the honest test.
    permissionProblem = false;
    await keepStorage();
    await offerToRemember(token);
    renderTokenStatus();
    closeTokenModal();
    await start();
    toast('Connected — drag a card to test it saves.');
  } catch (e) {
    gh.token = previous;
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

on('#btn-connect', 'click', connectGitHub);
on('#banner-connect', 'click', connectGitHub);
on('#token-form', 'submit', (e) => {
  e.preventDefault();
  saveToken();
});
on('#token-cancel', 'click', closeTokenModal);
on('#token-disconnect', 'click', disconnectGitHub);
on('#token-test', 'click', testToken);
on('#token-modal', 'click', (e) => e.target.id === 'token-modal' && closeTokenModal());

on('#drawer-close', 'click', closeDrawer);
on('#scrim', 'click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

on('#d-title', 'change', (e) => {
  const value = e.target.value.trim();
  if (value) patchOpen({ title: value }, `task: retitle ${openFile.replace(/\.md$/, '')}`);
});
on('#d-desc', 'change', (e) =>
  patchOpen({ body: e.target.value }, `task: edit ${openFile.replace(/\.md$/, '')}`)
);
on('#d-due', 'change', (e) =>
  patchOpen({ due: e.target.value }, `task: due ${openFile.replace(/\.md$/, '')}`)
);
on('#d-labels', 'change', (e) =>
  patchOpen(
    { labels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) },
    `task: labels ${openFile.replace(/\.md$/, '')}`
  )
);
on('#d-assignee', 'change', (e) =>
  patchOpen({ assignee: e.target.value }, `task: assign ${openFile.replace(/\.md$/, '')}`)
);
on('#d-status', 'change', (e) => moveTask(openFile, e.target.value));
on('#d-delete', 'click', () => requestDelete(openFile));

async function start() {
  try {
    $('#page-meta').textContent = 'Loading from GitHub…';
    tasks = await loadTasks();
    render();
  } catch (err) {
    $('#page-meta').textContent = err.message;
    $('#board').innerHTML = '';
    $('#board').appendChild(el('div', 'muted', err.message));
    renderConnection();
  }
}

start();
