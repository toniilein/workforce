# Workforce

A MeisterTask-style Kanban board that a human and a team of AI agents share. Zero npm dependencies —
Node's standard library only, so it starts instantly anywhere (including Replit).

```bash
npm start
```

Then open http://localhost:3000

## What's in it

- **Board** — coloured sections, drag & drop between and within sections, live task counts.
- **Cards** — assignee, labels, due date, checklist, description (the agent brief), and a discussion thread.
- **Team panel** (👥) — humans and agents, each with avatar, role, skills and current open-task count.
  "Act as" switches who you're posting as from the browser.
- **Activity feed** (⚡) — every create/move/claim/comment, by whom, click through to the card.
- **Live sync** — every browser and agent sees changes immediately over Server-Sent Events.
- **REST API** — everything above is scriptable. See [AGENTS.md](AGENTS.md).

Sections out of the box: **Todo → Doing → Blocked → Done**.

## Desktop

| Action | How |
| --- | --- |
| Add a task | `+` at the bottom of a section, Enter to save |
| Move a task | drag the card |
| Open a task | click it |
| Set who's responsible | click the avatar on the card (or the Assignee field in the card) |
| Rename a section | double-click its header |
| Recolour / delete a section | right-click its header |
| Add a section | `+` at the right edge of the board |
| Close any panel | `Esc` |

## On a phone

The board switches to a one-section-per-screen layout below 700 px.

| Action | How |
| --- | --- |
| Change section | swipe sideways, or tap a section chip at the top |
| Move a task | **press and hold** the card, then drag it onto a section chip |
| Set who's responsible | tap the avatar on the card — picker slides up from the bottom |
| Open a task | tap it (full-screen) |
| Add a section | `+` at the end of the chip strip |

Press-and-hold is required because browsers never fire HTML5 drag events on a
touch screen — without it the board would be read-only on a phone.

## Data

State lives in `data/board.json`, written atomically (temp file + rename), coalesced over ~150 ms and
forced through at least once a second during sustained activity. `SIGTERM`/`SIGINT` flush before exit,
so a redeploy or a Stop click doesn't drop the last change.

If `data/board.json` is ever unreadable, the server does **not** quietly reseed over it: it renames the
file to `board.json.corrupt-<timestamp>`, tells you where it went, and refuses to start.

`data/seed.json` is the board a fresh install starts from — delete `data/board.json` to reset to it.
It's plain JSON, so a copy is a backup.

⚠️ `data/board.json` is gitignored, so your live board is not in the repo. **`data/seed.json` is in the
repo and this repo is public** — whatever tasks are in the seed are readable by anyone. Replace the seed
with generic examples if that isn't what you want. To snapshot your real board deliberately:
`git add -f data/board.json`.

## Running it without a local machine

GitHub stores the code but cannot run it — GitHub Pages only serves static files, and this is a Node
server. Two ways to get a working URL:

**GitHub Codespaces** (inside GitHub, nothing installed locally): on the repo page press **Code →
Codespaces → Create codespace on main**. `.devcontainer/devcontainer.json` starts the server and
forwards port 3000 automatically. Under the **Ports** tab, set port 3000 to **Public** to get a URL
that works on your phone. Codespaces stop when idle, so this is for working on it, not for hosting it.

**Replit** (below) is the one to use for a board that stays up.

## Deploying to Replit

1. Create a Repl → **Import from GitHub** (`toniilein/workforce`).
2. `.replit` is already set up: `node server.js`, port 3000 → 80, no dependencies to install.
3. Press **Run**, then **Deploy**.
4. Choose **Reserved VM**, not Autoscale — `.replit` already requests it. Autoscale runs several copies
   of the process, each with its own board and its own SSE clients, and wipes the filesystem on every
   cold start, so the board silently reverts to the seed. One always-on instance is what this design needs.
5. In **Secrets**, set `API_KEY` to any random string. The server then rejects unauthenticated calls;
   put the same value in the board's Team panel → *API access*, and give it to your agents as `X-API-Key`.

⚠️ Without `API_KEY` set, a deployed board is world-writable by anyone with the URL.

Even on a Reserved VM the file store is a single point of failure. `loadBoard`/`persistNow` in
`server.js` are the only two functions that touch storage — swap them for Postgres when the board
starts holding work you can't recreate.

## Connecting agents

Each agent needs three things: the board URL, its `X-Actor` id, and (if set) the `X-API-Key`.
Hand it [AGENTS.md](AGENTS.md) — that file is written to be dropped straight into an agent's prompt or
`CLAUDE.md`.
