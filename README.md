# llmfiles

Personal LLM config, plugins, agents, commands, and skills.

This repo is the source of truth. Tool-specific installs are opt-in symlinks, not copied mirrors.

## Layout

- `profiles/opencode/` contains the base OpenCode profile.
- `plugins/opencode/` contains OpenCode-only plugins.
- `skills/collections/` contains vendored skill collections.
- `skills/local/` contains local standalone skills.
- `justfile` links the pieces into whichever config folder you choose.

## Install

```bash
just install-opencode                         # ~/.config/opencode, no plugins or skill collections
just install-opencode-plugins                 # opt-in OpenCode plugins
just install-opencode-skills                  # opt-in vendored OpenCode skill collections
just install-opencode-all                     # core + plugins + skill collections

just install-agents-skills                    # ~/.agents/skills
just install-claude-skills                    # ~/.claude/skills

just install-opencode /tmp/opencode           # custom target
just install-local-skill ntfy /tmp/skills     # one local skill to any target
```

Existing real files are skipped. Existing symlinks are relinked.

## Sync notes

Do not commit runtime state or secrets. This repo excludes dependency folders, caches, logs, `.env` files, private keys, zip archives, and other secret-shaped files.

Before pushing updates:

```bash
git diff --cached --name-only
git diff --cached
```
