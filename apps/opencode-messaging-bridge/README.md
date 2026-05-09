# OpenCode messaging bridge

Standalone daemon for routing Telegram and Discord messages into OpenCode sessions.

This package is Phase 1 of the bridge plan in `../../docs/opencode-messaging-bridge.md`. It currently provides the foundation pieces only:

- environment config parsing
- atomic JSON state storage
- OpenCode HTTP client for health checks, session listing, and session creation
- CLI commands for checking the configured OpenCode server

It does not start Telegram or Discord adapters yet.

## Setup

Install package dependencies:

```bash
yarn install
```

Start OpenCode separately:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Set the bridge target:

```bash
export OPENCODE_BRIDGE_OPENCODE_BASE_URL="http://127.0.0.1:4096"
```

## Commands

```bash
yarn start status
yarn start sessions
yarn start new "Session title"
yarn check
```

The state file defaults to:

```text
$XDG_STATE_HOME/opencode-messaging-bridge/state.json
```

If `XDG_STATE_HOME` is not set, it falls back to:

```text
$HOME/.local/state/opencode-messaging-bridge/state.json
```

The state file stores routing state only. Do not put tokens, OpenCode passwords, API keys, or other secrets in it.
