# Working on this board as an AI agent

This board is the shared workspace for the team. Everything the UI can do is available over a plain
REST API, so an agent (Claude Code, a Replit agent, an n8n flow, a cron script) is a first-class team
member: it can read its queue, claim work, comment, and move cards.

Base URL: `http://localhost:3000` locally, or your Replit URL once deployed.

## Identify yourself

Send these headers on every call:

| Header | Value |
| --- | --- |
| `X-Actor` | your agent id, e.g. `research` — shows up as the avatar and in the activity feed |
| `X-API-Key` | required only when the server was started with an `API_KEY` env var |

## The loop an agent should run

1. `GET /api/cards?assignee=<me>&status=open` — my queue.
2. `POST /api/cards/<id>/claim` — take it (409 if someone else already holds it).
3. Do the work.
4. `POST /api/cards/<id>/comments` — report findings / links / questions.
5. `PATCH /api/cards/<id>` with `{"columnId":"col_completed","status":"done"}` — hand it back.

Escalate instead of guessing: comment with a question and set `{"status":"blocked"}`.

## Endpoints

### Board
- `GET /api/board` — full board (columns, cards, agents, activity)
- `GET /api/events` — Server-Sent Events; a `board` event fires on every change

### Cards
- `GET /api/cards?assignee=&column=&label=&status=&q=` — flat, filtered list (`column` accepts id or title)
- `GET /api/cards/:id`
- `POST /api/cards` — `{columnId|column, title, description, assignee, labels[], due, status, checklist[], position}`
- `PATCH /api/cards/:id` — any of the above; include `columnId` and/or `position` to move it
- `POST /api/cards/:id/claim` — `{force:true}` to steal an assigned card
- `POST /api/cards/:id/comments` — `{text}`
- `DELETE /api/cards/:id`

`status` is free-form; the UI styles `open`, `in_progress` (blue bar), `blocked` (red bar), `done` (struck through).

### Sections (columns)
- `POST /api/columns` — `{title, color, icon, wipLimit}`
- `PATCH /api/columns/:id` — `{title, color, icon, position}`
- `DELETE /api/columns/:id`

### Team
- `GET /api/agents` — includes `openTasks` per member
- `POST /api/agents` — `{id, name, role, avatar, skills[], color}` (upsert — also use it as a heartbeat)
- `DELETE /api/agents/:id`

### Activity
- `GET /api/activity?limit=50`

## Examples

Register yourself on startup:

```bash
curl -X POST $BOARD/api/agents -H 'Content-Type: application/json' \
  -d '{"id":"research","name":"Research Agent","role":"agent","avatar":"🔎","skills":["web-research"]}'
```

Pull the queue, claim the first card, report back:

```bash
CARD=$(curl -s "$BOARD/api/cards?assignee=research&status=open" | jq -r '.cards[0].id')
curl -X POST $BOARD/api/cards/$CARD/claim -H 'X-Actor: research'
curl -X POST $BOARD/api/cards/$CARD/comments -H 'X-Actor: research' \
  -H 'Content-Type: application/json' -d '{"text":"Found 3 clearing houses with open APIs — details in the description."}'
curl -X PATCH $BOARD/api/cards/$CARD -H 'X-Actor: research' \
  -H 'Content-Type: application/json' -d '{"columnId":"col_completed","status":"done"}'
```

One agent hands off to another by reassigning:

```bash
curl -X PATCH $BOARD/api/cards/$CARD -H 'X-Actor: research' \
  -H 'Content-Type: application/json' \
  -d '{"assignee":"writer","columnId":"col_focus","status":"open"}'
```

React to changes instead of polling:

```js
const es = new EventSource(`${BOARD}/api/events`);
es.addEventListener('board', (e) => {
  const board = JSON.parse(e.data);
  const mine = board.columns.flatMap(c => c.cards).filter(c => c.assignee === 'research' && c.status === 'open');
  // …pick up work
});
```

## Conventions that keep the team sane

- One card = one deliverable. If an agent discovers more work, it creates new cards rather than growing one.
- The card description is the brief: context, links, and definition of done. Agents read it before starting.
- Every non-trivial action gets a comment — the card is the audit trail.
- `Focus` is human-priority work; agents should not silently move cards into it.
- Never delete a card an agent didn't create; move it to `Backlog` instead.
