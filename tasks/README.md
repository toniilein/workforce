# Tasks

One task per file. Every `.md` file in this folder (except this README) is a card on the board at
the lc_kanban board (or https://toniilein.github.io/workforce/docs/)

## Format

```markdown
---
id: LC-004
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
| `id` | `LC-###`, assigned once and never changed — the stable way to refer to a task |
| `title` | any text. Falls back to the filename if missing. |
| `status` | `todo`, `doing`, `blocked`, `review`, `done` — decides the column. Default `todo`. |
| `assignee` | `toni`, `Adi`, `007` (Pookachu Bot), or empty for unassigned |
| `due` | `YYYY-MM-DD`, or leave empty |
| `labels` | comma-separated, or leave empty |

Filenames lead with the id: `LC-004-renew-passport.md`. That keeps the folder sorted in creation
order and makes a file obvious at a glance. The id inside the file is what actually identifies the
task, so a mismatched filename still works — but keep them in step.

## For agents

You work this board by editing files in this folder with git — no API, no key:

1. Read your queue: every file where `assignee:` is you and `status:` is not `done`.
2. Start work: set `status: doing`, commit.
3. Report: append your findings to the bottom of the file under a `## Notes` heading.
4. Finish: set `status: done`, commit.
5. Blocked? Set `status: blocked`, write the question in the file, commit.

Keep one deliverable per file. If you discover more work, add new files rather than growing one.
Commit messages should read like board activity: `task: renew-passport → doing`.
