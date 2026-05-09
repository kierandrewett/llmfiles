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
just opencode-plugin-check                    # typecheck and smoke-test OpenCode plugins

just install-opencode /tmp/opencode           # custom target
just install-local-skill ntfy /tmp/skills     # one local skill to any target
```

Existing real files are skipped. Existing symlinks are relinked.

If `~/.config/opencode/plugins` already exists as a real directory, `just install-opencode-plugins` links each repo-managed plugin file into that directory and leaves any existing real files alone.

## OpenCode remote control

Yes, Discord can run through the standalone bridge. The daemon is the main path for server or Docker-based remote
control now; the older Discord plugin is still available for plugin-specific OpenCode behaviour.

For local Discord control from the repo root, set the Discord env vars and let the bridge start `opencode serve` on
loopback:

```bash
export OPENCODE_BRIDGE_DISCORD_BOT_TOKEN="replace-with-real-token"
export OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_APPLICATION_ID="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_GUILD_ID="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_REGISTER_SLASH_COMMANDS="1"
export OPENCODE_BRIDGE_MANAGE_OPENCODE="1"
export OPENCODE_BRIDGE_OPENCODE_HOST="127.0.0.1"
export OPENCODE_BRIDGE_OPENCODE_PORT="4096"
export OPENCODE_BRIDGE_OPENCODE_WORKDIR="/path/to/project"

just opencode-bridge discord
```

For Docker Compose, set `OPENCODE_BRIDGE_COMMAND=discord` in
`apps/opencode-messaging-bridge/.env`, put real Discord tokens in the private runtime env file outside the repo, then run:

```bash
cd apps/opencode-messaging-bridge
docker compose up -d --build
docker compose logs -f opencode-bridge
```

Slash commands work without Discord's Message Content privileged intent. Enable Message Content only if you want `!oc ...`
prefix commands or plain-text guild replies.

Start with the package README for the full setup, env files, Docker mounts, and smoke tests:

```text
apps/opencode-messaging-bridge/README.md
```

The Docker path keeps `opencode serve` on loopback inside the container, mounts OpenCode auth/config and the target repo at
runtime, and stores Telegram offsets, Discord Gateway resume state, slash-command registration signatures, and session
bindings in a Docker volume.

## Sync notes

Do not commit runtime state or secrets. This repo excludes dependency folders, caches, logs, `.env` files, private keys, zip archives, and other secret-shaped files.

Before pushing updates:

```bash
git diff --cached --name-only
git diff --cached
```
