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

## Keyboard / mouse

| Action | How |
| --- | --- |
| Add a task | `+` at the bottom of a section, Enter to save |
| Move a task | drag the card |
| Open a task | click it |
| Rename a section | double-click its header |
| Recolour / delete a section | right-click its header |
| Add a section | `+` at the right edge of the board |
| Close any panel | `Esc` |

## Data

State lives in `data/board.json` (written atomically on each change). `data/seed.json` is the starting
board — delete `data/board.json` to reset. It's plain JSON, so a copy is a backup.

`data/board.json` is **gitignored** on purpose: the repo carries the empty-ish seed, not your live
tasks. To snapshot the real board anyway: `git add -f data/board.json`.

## Deploying to Replit

1. Create a Repl → **Import from GitHub**, or drag this folder into a blank Node.js Repl.
2. `.replit` is already set up (`node server.js`, port 3000 → 80).
3. Press **Run**, then **Deploy** for a stable URL.
4. In **Secrets**, set `API_KEY` to any random string. The server then rejects unauthenticated calls;
   put the same value in the board's Team panel → *API access*, and give it to your agents as
   `X-API-Key`.

⚠️ Without `API_KEY` set, a deployed board is world-writable. Set it before sharing the URL.

Replit's filesystem is ephemeral on redeploy — for anything you can't afford to lose, commit
`data/board.json` to git periodically or swap the store in `server.js` (`loadBoard`/`persistNow`) for
Replit DB or Postgres. Those two functions are the only place storage is touched.

## Connecting agents

Each agent needs three things: the board URL, its `X-Actor` id, and (if set) the `X-API-Key`.
Hand it [AGENTS.md](AGENTS.md) — that file is written to be dropped straight into an agent's prompt or
`CLAUDE.md`.
