/*
 * The write side of the GitHub Pages board.
 *
 * There is no server, so the page commits to the repo itself through GitHub's
 * contents API. That needs a token, which the user pastes once and which lives
 * only in this browser's localStorage — it is never sent anywhere but github.com.
 *
 * Without a token everything still loads; the board is simply read-only.
 */

const TOKEN_KEY = 'board.gh.token';
const SAVED_KEY = 'board.gh.savedAt';

const gh = {
  get token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  },
  set token(v) {
    if (v) {
      localStorage.setItem(TOKEN_KEY, v);
      localStorage.setItem(SAVED_KEY, new Date().toISOString());
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(SAVED_KEY);
    }
  },
  get connected() {
    return Boolean(this.token);
  },
  get savedAt() {
    return localStorage.getItem(SAVED_KEY) || '';
  },
  // Never render the whole secret — enough to recognise which token this is.
  get masked() {
    const t = this.token;
    if (!t) return '';
    return t.length <= 12 ? '••••' : `${t.slice(0, 11)}…${t.slice(-4)}`;
  },
};

function ghHeaders(extra = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...extra };
  if (gh.token) headers.Authorization = `Bearer ${gh.token}`;
  return headers;
}

async function ghFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: ghHeaders(options.headers) });
  if (res.ok) return res.status === 204 ? null : res.json();

  const detail = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Token rejected — reconnect with a valid token.');
  if (res.status === 403)
    throw new Error(
      gh.connected
        ? "Token lacks permission — it needs Contents: Read and write on this repo."
        : "GitHub's anonymous rate limit is reached. Connect a token, or wait a few minutes."
    );
  if (res.status === 409) throw new Error('That file changed on GitHub — hit Refresh and try again.');
  throw new Error(detail.message || `GitHub returned ${res.status}`);
}

/* Base64 for UTF-8 content — btoa alone mangles anything non-ASCII. */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const contentsUrl = (repo, path) =>
  `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;

// Create or update a file. `sha` must be the current blob sha when replacing.
async function putFile(repo, path, text, message, sha) {
  return ghFetch(contentsUrl(repo, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64(text),
      branch: repo.branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

async function deleteFile(repo, path, message, sha) {
  return ghFetch(contentsUrl(repo, path), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, branch: repo.branch, sha }),
  });
}

// Confirms the token works AND can write, before we let the UI pretend it can.
async function checkAccess(repo) {
  const info = await ghFetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`);
  if (!info.permissions?.push) throw new Error('That token can read but not write to this repo.');
  return info;
}
