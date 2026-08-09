# Tasks

One task per file. Every `.md` file in this folder (except this README) is a card on the board at
https://toniilein.github.io/workforce/

## Format

```markdown
---
title: Renew passport before October trip
status: todo
assignee: toni
due: 2026-09-01
labels: errands, travel
---

Book the appointment, bring the old passport and two photos.
Everything under the `---` block is the description — the brief.
```

| Field | Values |
| --- | --- |
| `title` | any text. Falls back to the filename if missing. |
| `status` | `todo`, `doing`, `blocked`, `done` — decides the column. Default `todo`. |
| `assignee` | `toni`, `jasmin`, `mucki`, or empty for unassigned |
| `due` | `YYYY-MM-DD`, or leave empty |
| `labels` | comma-separated, or leave empty |

The filename is free-form; `renew-passport.md` is nicer than `task-1.md` but nothing depends on it.

## For agents

You work this board by editing files in this folder with git — no API, no key:

1. Read your queue: every file where `assignee:` is you and `status:` is not `done`.
2. Start work: set `status: doing`, commit.
3. Report: append your findings to the bottom of the file under a `## Notes` heading.
4. Finish: set `status: done`, commit.
5. Blocked? Set `status: blocked`, write the question in the file, commit.

Keep one deliverable per file. If you discover more work, add new files rather than growing one.
Commit messages should read like board activity: `task: renew-passport → doing`.
