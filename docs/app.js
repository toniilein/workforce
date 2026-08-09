/*
 * Board — the GitHub Pages build.
 *
 * There is no server here. The board is rendered from the .md files in the
 * repo's tasks/ folder: GitHub's API lists them, the raw CDN serves them, and
 * this file parses the frontmatter into cards.
 *
 * Editing happens on GitHub — a card links to that file in GitHub's editor —
 * and agents change the same files with git. So the repo IS the database.
 */

const REPO = { owner: 'toniilein', name: 'workforce', branch: 'main', dir: 'tasks' };

const SECTIONS = [
  { id: 'todo', title: 'Todo', color: '#3d4451' },
  { id: 'doing', title: 'Doing', color: '#4f8ef7' },
  { id: 'blocked', title: 'Blocked', color: '#e2504f' },
  { id: 'done', title: 'Done', color: '#4bc07a' },
];

// Known people; anyone else named in a file still shows up, in grey.
const PEOPLE = {
  toni: { name: 'Toni', color: '#2f3542' },
  jasmin: { name: 'Jasmin', color: '#cd6a56' },
  mucki: { name: 'Mucki Bot', color: '#5b8aa6' },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let tasks = [];
let filter = { text: '', assignee: '', label: '' };

/* ------------------------------------------------------------------ github */

const editUrl = (file) =>
  `https://github.com/${REPO.owner}/${REPO.name}/edit/${REPO.branch}/${REPO.dir}/${encodeURIComponent(file)}`;

const NEW_TEMPLATE = `---
title: New task
status: todo
assignee:
due:
labels:
---

Describe the task here. This text is the brief an agent reads before starting.
`;

function newTaskUrl() {
  const base = `https://github.com/${REPO.owner}/${REPO.name}/new/${REPO.branch}`;
  const params = new URLSearchParams({ filename: `${REPO.dir}/new-task.md`, value: NEW_TEMPLATE });
  return `${base}?${params}`;
}

async function loadTasks() {
  const listUrl = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${REPO.dir}?ref=${REPO.branch}`;
  const res = await fetch(listUrl, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "GitHub's rate limit is reached — try again in a few minutes."
        : `GitHub said ${res.status} listing ${REPO.dir}/`
    );
  }
  const files = (await res.json()).filter(
    (f) => f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md'
  );

  // download_url points at the raw CDN, which is cached for a few minutes;
  // the cache-buster makes Refresh actually refresh.
  const bust = Date.now();
  const loaded = await Promise.all(
    files.map(async (f) => {
      const text = await fetch(`${f.download_url}?t=${bust}`).then((r) => (r.ok ? r.text() : ''));
      return parseTask(f.name, text);
    })
  );
  return loaded.filter(Boolean);
}

/* ------------------------------------------------------------------ parsing */

// Minimal frontmatter reader: `key: value` lines between the leading --- pair.
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
    assignee: (meta.assignee || '').toLowerCase(),
    due: /^\d{4}-\d{2}-\d{2}$/.test(meta.due || '') ? meta.due : '',
    labels: (meta.labels || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    body,
  };
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

function parseDay(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function isOverdue(iso) {
  const t = new Date();
  return parseDay(iso) < new Date(t.getFullYear(), t.getMonth(), t.getDate());
}
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
  const card = el('a', `card ${task.status}`);
  card.href = editUrl(task.file);
  card.target = '_blank';
  card.rel = 'noopener';
  card.title = `Edit ${task.file} on GitHub`;

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
  return card;
}

function render() {
  const board = $('#board');
  board.innerHTML = '';

  for (const section of SECTIONS) {
    const wrap = el('div', 'column');
    const head = el('div', 'col-head');
    head.style.setProperty('--c', section.color);
    head.append(el('span', 'title', section.title));

    const all = tasks.filter((t) => t.status === section.id);
    const visible = all.filter(matchesFilter);
    head.appendChild(el('span', 'count', String(visible.length)));

    const body = el('div', 'col-body');
    for (const task of visible) body.appendChild(cardNode(task));

    const add = el('a', 'add-card', '+ Add task');
    add.href = newTaskUrl();
    add.target = '_blank';
    add.rel = 'noopener';
    body.appendChild(add);

    wrap.append(head, body);
    board.appendChild(wrap);
  }

  renderWorkload();
  renderLabels();
  renderSectionTabs();

  const open = tasks.filter((t) => t.status !== 'done').length;
  $('#page-meta').textContent = `${open} open task${open === 1 ? '' : 's'} · ${tasks.length} files in tasks/`;
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

// Phone layout: one section per screen, chips to jump between them.
function renderSectionTabs() {
  const strip = $('#sectiontabs');
  strip.innerHTML = '';
  SECTIONS.forEach((section, i) => {
    const count = tasks.filter((t) => t.status === section.id && matchesFilter(t)).length;
    const tab = el('button', 'sectiontab' + (i === 0 ? ' active' : ''));
    tab.style.setProperty('--c', section.color);
    tab.dataset.id = section.id;
    tab.append(el('span', 't', section.title), el('span', 'n', String(count)));
    tab.addEventListener('click', () => {
      const node = [...document.querySelectorAll('.column')][i];
      if (node) $('#board').scrollTo({ left: node.offsetLeft, behavior: 'smooth' });
      document.querySelectorAll('.sectiontab').forEach((t) => t.classList.toggle('active', t === tab));
    });
    strip.appendChild(tab);
  });
}

/* ------------------------------------------------------------------ wiring */

$('#search').addEventListener('input', (e) => {
  filter.text = e.target.value.trim().toLowerCase();
  render();
});
$('#btn-refresh').addEventListener('click', () => start());
$('#btn-new').href = newTaskUrl();
$('#repo-link').href = `https://github.com/${REPO.owner}/${REPO.name}/tree/${REPO.branch}/${REPO.dir}`;

async function start() {
  const live = $('#live');
  try {
    $('#page-meta').textContent = 'Loading from GitHub…';
    tasks = await loadTasks();
    live.classList.remove('off');
    render();
  } catch (err) {
    live.classList.add('off');
    $('#page-meta').textContent = err.message;
    $('#board').innerHTML = '';
    $('#board').appendChild(el('div', 'muted', err.message));
  }
}

start();
