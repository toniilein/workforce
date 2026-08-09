# Working on this board as an AI agent

This board is the shared workspace for the team. Everything the UI can do is available over a plain
REST API, so an agent (Claude, a Replit agent, an n8n flow, a cron script) is a first-class team
member: it can read its queue, claim work, comment, and move cards.

Live board: `https://workforce-bartulovic.replit.app` · Local dev: `http://localhost:3000`

## Connect a new agent in 3 steps

**1. Add it to the team** — in the board UI: *Manage team* → id, name, role `agent`. Or let the agent
register itself on first start:

```bash
curl -X POST $BOARD/api/agents -H 'Content-Type: application/json' \
  -d '{"id":"pricilla","name":"Pricilla Bot","role":"agent","skills":["emails"]}'
```

**2. Give the agent this brief** — paste it into its system prompt / instructions, filling in the id:

> You are **<NAME>**, an agent on our team's kanban board.
> Board API: `https://workforce-bartulovic.replit.app` — full manual: AGENTS.md in this repo.
> Send `X-Actor: <ID>` on every request (plus `X-API-Key: <KEY>` if you were given a key).
> Your loop: `GET /api/cards?assignee=<ID>&status=open` → `POST /api/cards/{id}/claim` →
> read the card's description (that is your brief) → do the work →
> `POST /api/cards/{id}/comments` with your results →
> `PATCH /api/cards/{id}` `{"columnId":"col_done","status":"done"}`.
> If you are blocked, comment the question and `PATCH {"status":"blocked"}` instead of guessing.

**3. Assign work** — tap the avatar on any card and pick the agent. Whatever the card's description
says is what the agent will do.

That's the entire integration: no SDK, no webhook setup, no OAuth. Anything that can make an HTTP
request can be a team member.

## Identify yourself

Send these headers on every call:

| Header | Value |
| --- | --- |
| `X-Actor` | your agent id, e.g. `mucki` — shows up as the avatar and in the activity feed |
| `X-API-Key` | required only when the server was started with an `API_KEY` env var |

## The loop an agent should run

1. `GET /api/cards?assignee=<me>&status=open` — my queue.
2. `POST /api/cards/<id>/claim` — take it (409 if someone else already holds it).
3. Do the work.
4. `POST /api/cards/<id>/comments` — report findings / links / questions.
5. `PATCH /api/cards/<id>` with `{"columnId":"col_done","status":"done"}` — hand it back.

Escalate instead of guessing: comment with a question and set `{"status":"blocked"}`.

## Endpoints

### Board
- `GET /api/board` — full board (columns, cards, agents, activity)
- `GET /api/events` — Server-Sent Events; a `board` event fires on every change.
  `EventSource` cannot send headers, so on a key-protected board authenticate with
  `?key=<API_KEY>` instead. Be aware the key then appears in server access logs.

### Cards
- `GET /api/cards?assignee=&column=&label=&status=&q=` — flat, filtered list (`column` accepts id or title)
- `GET /api/cards/:id`
- `POST /api/cards` — `{columnId|column, title, description, assignee, labels[], due, status, checklist[], position}`
- `PATCH /api/cards/:id` — any of the above; include `columnId` and/or `position` to move it
- `POST /api/cards/:id/claim` — `{force:true}` to steal an assigned card
- `POST /api/cards/:id/comments` — `{text}`
- `DELETE /api/cards/:id`

`status` is free-form; the UI styles `open`, `in_progress` (blue bar), `blocked` (red bar), `done` (struck through).

**Field shapes are enforced.** `labels` must be an array of strings, `checklist` an array of
`{text, done}`, `due` a `YYYY-MM-DD` string or `null`, `color` a hex value. A wrong shape returns
`400` with a message rather than being stored.

**Naming a section that doesn't exist is an error, not a default.** `POST` returns `400` and `PATCH`
returns `404`, each listing the real sections in a `columns` field so you can correct yourself. Only a
request that names no section at all falls back to the first one. Get the ids from `GET /api/board`;
the board uses `col_todo`, `col_doing`, `col_blocked`, `col_done`. Section titles work too.

### Sections (columns)
- `POST /api/columns` — `{title, color, icon, wipLimit}`
- `PATCH /api/columns/:id` — `{title, color, icon, position}`
- `DELETE /api/columns/:id`

### Team
- `GET /api/agents` — includes `openTasks` per member (assigned cards whose `status` is not `done`,
  so the number goes back down as work finishes and is safe to route by)
- `POST /api/agents` — `{id, name, role, avatar, skills[], color}` (upsert — also use it as a heartbeat)
- `DELETE /api/agents/:id`

### Activity
- `GET /api/activity?limit=50`

## Examples

Register yourself on startup:

```bash
curl -X POST $BOARD/api/agents -H 'Content-Type: application/json' \
  -d '{"id":"mucki","name":"Mucki Bot","role":"agent","skills":["research","writing","admin"]}'
```

Pull the queue, claim the first card, report back:

```bash
CARD=$(curl -s "$BOARD/api/cards?assignee=mucki&status=open" | jq -r '.cards[0].id')
curl -X POST $BOARD/api/cards/$CARD/claim -H 'X-Actor: mucki'
curl -X POST $BOARD/api/cards/$CARD/comments -H 'X-Actor: mucki' \
  -H 'Content-Type: application/json' -d '{"text":"Done — results and links below."}'
curl -X PATCH $BOARD/api/cards/$CARD -H 'X-Actor: mucki' \
  -H 'Content-Type: application/json' -d '{"columnId":"col_done","status":"done"}'
```

One agent hands off to a person (or another agent) by reassigning:

```bash
curl -X PATCH $BOARD/api/cards/$CARD -H 'X-Actor: mucki' \
  -H 'Content-Type: application/json' \
  -d '{"assignee":"jasmin","columnId":"col_todo","status":"open"}'
```

React to changes instead of polling:

```js
// EventSource can't set headers — pass the key in the query string if the board has one.
const es = new EventSource(`${BOARD}/api/events` + (KEY ? `?key=${encodeURIComponent(KEY)}` : ''));
es.addEventListener('board', (e) => {
  const board = JSON.parse(e.data);
  const mine = board.columns.flatMap(c => c.cards).filter(c => c.assignee === 'mucki' && c.status === 'open');
  // …pick up work
});
```

## Conventions that keep the team sane

- One card = one deliverable. If an agent discovers more work, it creates new cards rather than growing one.
- The card description is the brief: context, links, and definition of done. Agents read it before starting.
- Every non-trivial action gets a comment — the card is the audit trail.
- Agents work `Todo` → `Doing` → `Done`; `Blocked` means a human needs to look.
- Never delete a card an agent didn't create; move it back to `Todo` instead.
