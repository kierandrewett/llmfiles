# llmfiles

Personal LLM agent configuration, plugins, and skills.

## Layout

- `opencode/` mirrors selected shareable files from `~/.config/opencode/`.
- `agents/skills/` mirrors global skills from `~/.agents/skills/`.
- `claude/skills/` mirrors global skills from `~/.claude/skills/`.

## Sync notes

This repo intentionally excludes runtime state and dependency folders such as `node_modules/`, caches, logs, `.env` files, private keys, zip archives, and other secret-shaped files.

Before pushing updates, scan staged content for secrets:

```bash
git diff --cached --name-only
git diff --cached
```

The OpenCode config currently contains local absolute paths, so treat this as a personal backup rather than a portable public template.
