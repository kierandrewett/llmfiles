# OpenCode messaging bridge

Standalone daemon for routing Telegram and Discord messages into OpenCode sessions.

This package implements the Phase 1 foundation and the first Telegram inbound slice from
`../../docs/opencode-messaging-bridge.md`:

- environment config parsing
- atomic JSON state storage
- OpenCode HTTP client for health checks, session listing, session creation, prompt sends, and aborts
- Telegram Bot API long polling and text responses
- allowlisted Telegram command routing for `/oc status`, `/oc sessions`, `/oc attach`, `/oc new`, `/oc prompt`, and
  `/oc abort`
- OpenCode server-sent event relay for bound Telegram sessions, currently for assistant text parts
- CLI commands for checking the configured OpenCode server and running Telegram polling

It does not start Discord or handle OpenCode permission replies from Telegram yet.

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

For Telegram polling, also set the bot token and allowlist. Keep these values in an untracked shell file or local
environment, not in git:

```bash
export OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN="..."
export OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS="12345"
export OPENCODE_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS="12345" # optional, but recommended
```

## Commands

```bash
yarn start status
yarn start sessions
yarn start new "Session title"
yarn start telegram-once
yarn start telegram
yarn check
```

`telegram-once` processes one `getUpdates` response and exits. Use it for inbound smoke tests and service debugging.
`telegram` runs the same poller continuously and also subscribes to OpenCode server-sent events so bound session output
can be sent back to Telegram.

The state file defaults to:

```text
$XDG_STATE_HOME/opencode-messaging-bridge/state.json
```

If `XDG_STATE_HOME` is not set, it falls back to:

```text
$HOME/.local/state/opencode-messaging-bridge/state.json
```

The state file stores routing state only. Do not put tokens, OpenCode passwords, API keys, or other secrets in it.
