# Brief for a bot working this board

Give this file to any agent (Telegram bot, n8n flow, script) that should work the board.
Everything it needs is here; there is no server and no custom API — the board *is* the
`tasks/` folder of the GitHub repo, and GitHub's own API is the interface.

## Identity and access

| | |
| --- | --- |
| Repo | `toniilein/workforce`, branch `main` |
| Task folder | `tasks/` |
| Your id | `007` (shows on the board as "Pookachu Bot") |
| Auth | `Authorization: Bearer <YOUR_GITHUB_TOKEN>` on every request |
| Token needs | *Contents: Read and write* on this repo only |

Keep the token in the bot's own secret storage. Never print it in a chat reply, never
commit it into a file.

## What a task looks like

One task = one `.md` file in `tasks/`:

```markdown
---
title: Research risk events in Europe
status: doing
assignee: 007
due: 2026-08-20
labels: research
---

Everything below the --- block is the brief: context, links, definition of done.

## Notes
Findings get appended here.
```

`status` must be one of: `todo`, `doing`, `blocked`, `review`, `done`.
Only change the fields you mean to change — keep the rest of the file intact.

## The loop

1. **Find your work** — list the folder, read each file, keep the ones with
   `assignee: 007` and `status:` not `done`.
2. **Claim it** — set `status: doing` and save. Do this before working so a human can
   see it is being handled.
3. **Do the work** — the file body is the instruction.
4. **Report** — append your result under a `## Notes` heading in the same file. Write
   what you found, with links. This is how the human reads your output.
5. **Finish** — set `status: done` and save.
6. **Stuck?** — set `status: blocked`, write the question in the body, save. Do not guess.

Conventions: one deliverable per file; if you discover more work, create new files rather
than growing one. Commit messages read like board activity: `task: <file> → doing`.

## The four calls

**1. List the tasks**

```
GET https://api.github.com/repos/toniilein/workforce/contents/tasks
Authorization: Bearer <TOKEN>
Accept: application/vnd.github+json
```

Returns an array; each entry has `name`, `sha` and `download_url`. Ignore `README.md`.

**2. Read one task**

Fetch the entry's `download_url` (plain text, no auth needed on a public repo), or:

```
GET https://api.github.com/repos/toniilein/workforce/contents/tasks/<file>.md
```

which returns `content` **base64-encoded** plus the `sha` you need in order to write.

**3. Write a task** (create or update)

```
PUT https://api.github.com/repos/toniilein/workforce/contents/tasks/<file>.md
Authorization: Bearer <TOKEN>
Content-Type: application/json

{
  "message": "task: <file> → doing",
  "content": "<the WHOLE new file, base64-encoded UTF-8>",
  "sha": "<the sha you just read>",
  "branch": "main"
}
```

Two things that trip bots up:

- `content` is the **entire file**, base64 encoded — not a patch, not plain text.
- `sha` is required when updating an existing file, and must be the current one. Omit it
  only when creating a new file. If you get **409**, someone edited it first: re-read the
  file, reapply your change, retry.

**4. Delete a task** (rare — prefer moving it back to `todo`)

```
DELETE https://api.github.com/repos/toniilein/workforce/contents/tasks/<file>.md
{ "message": "task: remove <file>", "sha": "<sha>", "branch": "main" }
```

## Worked example (bash)

```bash
BOARD=https://api.github.com/repos/toniilein/workforce/contents/tasks
AUTH="Authorization: Bearer $TOKEN"

# 1. my open tasks
curl -s "$BOARD" -H "$AUTH" | jq -r '.[] | select(.name != "README.md") | .name' |
while read -r f; do
  body=$(curl -s "$BOARD/$f" -H "$AUTH")
  sha=$(echo "$body" | jq -r .sha)
  text=$(echo "$body" | jq -r .content | base64 -d)
  echo "$text" | grep -q '^assignee: 007' || continue
  echo "$text" | grep -q '^status: done' && continue

  # 2. claim it
  claimed=$(echo "$text" | sed 's/^status: .*/status: doing/')
  curl -s -X PUT "$BOARD/$f" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg m "task: ${f%.md} → doing" --arg c "$(echo "$claimed" | base64)" \
             --arg s "$sha" '{message:$m, content:$c, sha:$s, branch:"main"}')"
done
```

## Errors you will meet

| Code | Meaning | Do this |
| --- | --- | --- |
| 401 | token invalid or expired | ask the human for a new one |
| 403 | token lacks *Contents: Read and write* | ask the human to fix the token permission |
| 409 | the file changed since you read it | re-read, reapply, retry |
| 422 | usually a missing or wrong `sha` | re-read the file and use its current sha |

## Good manners

- Never touch a task that is not assigned to you.
- Never delete a task a human created; move it back to `todo` and say why in the notes.
- Keep the frontmatter valid — the board stops showing a card correctly if the `---`
  block is broken.
- Say what you did in the notes, not just that you did it.
