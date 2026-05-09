# llmfiles

Personal LLM config, plugins, agents, commands, and skills.

This repo is the source of truth. Tool-specific installs are opt-in symlinks, not copied mirrors.

## Layout

- `profiles/opencode/` contains the base OpenCode profile.
- `plugins/opencode/` contains OpenCode-only plugins.
- `apps/opencode-messaging-bridge/` contains the standalone OpenCode messaging bridge daemon.
- `docs/` contains design notes for standalone LLM tooling that is not an OpenCode plugin.
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

just opencode-bridge status                   # check the standalone OpenCode bridge
just opencode-bridge-check                    # typecheck and test the bridge app

just install-opencode /tmp/opencode           # custom target
just install-local-skill ntfy /tmp/skills     # one local skill to any target
```

Existing real files are skipped. Existing symlinks are relinked.

## OpenCode remote control

The standalone bridge can run in Docker Compose and let an allowlisted Telegram chat control an OpenCode session. Discord
control currently uses the existing OpenCode plugin rather than the Docker bridge. Start with the package README:

```text
apps/opencode-messaging-bridge/README.md
```

The Docker path keeps `opencode serve` on loopback inside the container, mounts OpenCode auth/config and the target repo at
runtime, and stores Telegram offsets plus session bindings in a Docker volume. The Discord plugin setup lives in
`plugins/opencode/discord-remote-control.md`.

## Sync notes

Do not commit runtime state or secrets. This repo excludes dependency folders, caches, logs, `.env` files, private keys, zip archives, and other secret-shaped files.

Before pushing updates:

```bash
git diff --cached --name-only
git diff --cached
```
