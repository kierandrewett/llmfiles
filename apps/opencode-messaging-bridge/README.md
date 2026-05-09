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
- optional OpenCode process supervision for `opencode serve`
- CLI commands for checking the configured OpenCode server and running Telegram polling

It does not start Discord or handle OpenCode permission replies from Telegram yet.

## Setup

Install package dependencies:

```bash
yarn install
```

By default, start OpenCode separately:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Set the bridge target:

```bash
export OPENCODE_BRIDGE_OPENCODE_BASE_URL="http://127.0.0.1:4096"
```

Or let the bridge manage `opencode serve`:

```bash
export OPENCODE_BRIDGE_MANAGE_OPENCODE="1"
export OPENCODE_BRIDGE_OPENCODE_HOST="127.0.0.1"
export OPENCODE_BRIDGE_OPENCODE_PORT="4096"
export OPENCODE_BRIDGE_OPENCODE_WORKDIR="/path/to/project"
```

The managed command is `opencode serve --hostname <host> --port <port>`. Override the binary path with
`OPENCODE_BRIDGE_OPENCODE_COMMAND` if the container or service environment needs it. Keep
`OPENCODE_BRIDGE_OPENCODE_BASE_URL` unset unless the bridge should connect to a different URL from the bind address.

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

## Docker

Build the bridge image from this package directory:

```bash
docker build -t opencode-messaging-bridge .
```

For a repeatable OpenCode version, pass the installer version from the OpenCode releases page:

```bash
docker build --build-arg OPENCODE_VERSION="1.0.180" -t opencode-messaging-bridge .
```

Run it with secrets and credentials mounted at runtime. Do not bake tokens into the image:

```bash
docker run --rm \
  --name opencode-bridge \
  --env-file /path/to/opencode-bridge.env \
  -e OPENCODE_BRIDGE_OPENCODE_WORKDIR="/workspace/project" \
  -v "$HOME/.local/share/opencode:/home/node/.local/share/opencode" \
  -v "$HOME/.config/opencode:/home/node/.config/opencode:ro" \
  -v "/path/to/project:/workspace/project" \
  -v opencode-bridge-state:/state \
  opencode-messaging-bridge
```

`/path/to/opencode-bridge.env` should contain bridge-only runtime settings, for example:

```bash
OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN=...
OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS=12345
OPENCODE_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS=12345
OPENCODE_BRIDGE_MANAGE_OPENCODE=1
```

OpenCode provider credentials are separate. OpenCode stores credentials created through `/connect` in
`~/.local/share/opencode/auth.json`, so ChatGPT Plus/Pro and OpenCode Go credentials should be prepared on the host and
mounted into the container at runtime. OAuth-style credentials may need write access for token refresh; if you do not want
the container writing to your host auth directory, copy the OpenCode auth directory into a private Docker volume and mount
that instead. The same rule applies to OpenCode config under `~/.config/opencode`: mount it at runtime, do not copy it
into the image, and do not commit generated auth files.
