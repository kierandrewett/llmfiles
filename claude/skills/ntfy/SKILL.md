---
name: ntfy
description: Send a push notification to Kieran via ntfy.drewett.dev. Use proactively when completing a significant task, making a controversial or non-standard decision, deleting important files, or any time you want to surface something important that shouldn't be missed.
user-invocable: true
allowed-tools: Bash
---

Send a push notification to the user.

## When to invoke this skill proactively (without being asked)

- **Task start**: When beginning a substantial multi-step task, send a notification with a brief plan ("Starting: X — will do A, B, C")
- **Milestone updates**: During long tasks, send a notification at each logical checkpoint ("Step 2/4 done: built the schema, starting migrations")
- **Task complete**: After finishing a substantial piece of work
- **Controversial decision**: Before or after taking an action that is risky, irreversible, or outside the norm (e.g. deleting files, force pushing, skipping a safety check, choosing an unusual approach) — use Priority: high
- **Blocker/decision point**: When genuinely stuck and need user input — not for permission grants (bypass permissions is enabled)

**Frequency guideline for long tasks:** Notify at the start, at each major step boundary, and at completion. Don't notify for every small action — aim for meaningful checkpoints that give a sense of progress.

## How to send the notification

Before sending, check whether Kieran is currently active:

```bash
active="$(curl -fsS --max-time 5 "https://is-kieran.drewett.dev/active?format=text" 2>/dev/null || true)"
if [ "$active" != "yes" ]; then
  exit 0
fi
```

Only send the notification when the endpoint returns exactly `yes`. If the endpoint returns `no`, the check fails, times out, or returns anything else, do not send the ntfy message and do not spend time debugging the active-check endpoint unless the task is specifically about notifications.

Use the Bash tool:

```bash
active="$(curl -fsS --max-time 5 "https://is-kieran.drewett.dev/active?format=text" 2>/dev/null || true)"
if [ "$active" = "yes" ]; then
  curl -s -X POST "https://ntfy.drewett.dev/claude" \
    -H "Authorization: Bearer $NTFY_API_TOKEN" \
    -H "Title: Claude Code" \
    -H "Priority: PRIORITY" \
    -d "YOUR MESSAGE HERE"
fi
```

**Priority values:**
- `default` — task complete, general updates
- `high` — controversial or non-standard decision made
- `urgent` — something went wrong or needs immediate attention

**Message guidance:** Write like a worker reporting to their manager — be specific about what you actually did, what you found, and what you're doing next. Name the files, commands, decisions, and outcomes. Don't be vague.

Bad: "Step 2 done, moving to next step."
Good: "Wrote migration 004_add_sessions_table.sql (5 columns, foreign key to users). Running `npm run migrate` against dev DB now — 3 migrations pending."

Bad: "Found an issue, investigating."
Good: "tests/auth.test.ts is failing — `login()` returns 401 when it should return 200. Looks like the token expiry was set to 0 by mistake in commit a3f9c1. Fixing now."

## When spawning subagents

Subagents don't inherit skills, but `$NTFY_API_TOKEN` is available to them. Include this in their prompt when you want them to report progress:

> Before sending progress notifications, check `curl -fsS --max-time 5 "https://is-kieran.drewett.dev/active?format=text"`. Only send if it returns exactly `yes`. If it returns `no`, fails, times out, or returns anything else, do not send. Send via: `curl -s -X POST "https://ntfy.drewett.dev/claude" -H "Authorization: Bearer $NTFY_API_TOKEN" -H "Title: Claude Code" -H "Priority: default" -d "your message"`. Notify at start, key milestones, and completion.

## If invoked via /ntfy

If `$ARGUMENTS` is non-empty, use it as the message body directly with `default` priority, unless the arguments specify otherwise.

```bash
active="$(curl -fsS --max-time 5 "https://is-kieran.drewett.dev/active?format=text" 2>/dev/null || true)"
if [ "$active" = "yes" ]; then
  curl -s -X POST "https://ntfy.drewett.dev/claude" \
    -H "Authorization: Bearer $NTFY_API_TOKEN" \
    -H "Title: Claude Code" \
    -H "Priority: default" \
    -d "$ARGUMENTS"
fi
```
