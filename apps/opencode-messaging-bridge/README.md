# OpenCode messaging bridge

Standalone daemon for controlling OpenCode sessions from Telegram or Discord.

This package implements the standalone bridge described in `../../docs/opencode-messaging-bridge.md`:

- environment config parsing
- atomic JSON state storage
- OpenCode HTTP client for health checks, session listing, session creation, prompt sends, and aborts
- Telegram Bot API long polling, command-menu registration, reactions, MarkdownV2 text responses, and streaming previews
- Discord Gateway, REST, slash-command, and prefix-command handling
- allowlisted Telegram command routing for `/oc ...` subcommands and first-class menu commands such as `/status`,
  `/sessions`, `/attach`, `/new`, `/prompt`, `/reply`, and `/abort`
- OpenCode server-sent event relay for bound Telegram and Discord sessions, including Telegram draft/edit previews for
  assistant text parts
- optional OpenCode process supervision for `opencode serve`
- CLI commands for checking the configured OpenCode server and running Telegram or Discord daemon loops

It does not handle OpenCode permission replies from Telegram or Discord yet.

## Contents

- [How Docker control works](#how-docker-control-works)
- [Control surface support](#control-surface-support)
- [Discord quickstart](#discord-quickstart)
- [Telegram setup](#telegram-setup)
- [Discord setup](#discord-setup)
- [Local setup](#local-setup)
- [Commands](#commands)
- [Docker](#docker)

## How Docker control works

The Docker image runs one bridge process. By default that bridge starts `opencode serve` inside the same container and
connects to it on loopback.

```text
Telegram app -> Telegram Bot API ----\
                                      bridge container -> opencode serve
Discord app  -> Discord Gateway/API -/        ^
                                               |
                                 mounted project/auth/config/state
```

No OpenCode HTTP port needs to be exposed. The container only needs outbound network access for the configured messaging
platform and whichever model provider OpenCode uses. Telegram uses Bot API long polling. Discord uses a Gateway WebSocket
for inbound messages and interactions, plus REST calls for responses. The bridge sends prompts to OpenCode, then relays
assistant text back to the bound chat or channel.

## Control surface support

| Surface | Runtime | Status |
| --- | --- | --- |
| Telegram | Standalone bridge app, Docker, or Docker Compose | Implemented here |
| Discord | Standalone bridge app, Docker, or Docker Compose | Implemented here |

The older `plugins/opencode/discord-remote-control.ts` plugin still exists and has extra plugin-specific behaviour such as
session threads, forum intake, and permission replies. The standalone daemon is now the proper Docker/server path for core
Discord control: `status`, `sessions`, `attach`, `new`, `prompt`, `reply`, `abort`, and assistant text relay.

## Discord quickstart

Use this path when you want Discord remote control through the standalone bridge. It keeps OpenCode HTTP on loopback and
uses Discord as the only exposed control surface.

From the repo root, run a local daemon with a bridge-managed `opencode serve` process:

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

For Docker Compose, build the resolved OpenCode config, then copy and edit the example files from this package directory:

```bash
just opencode-bridge-config
cp .env.example .env
mkdir -p "$HOME/.config/opencode-messaging-bridge"
cp bridge.env.example "$HOME/.config/opencode-messaging-bridge/env"
$EDITOR .env
$EDITOR "$HOME/.config/opencode-messaging-bridge/env"
```

Set this in `.env`:

```bash
OPENCODE_BRIDGE_COMMAND=discord
```

Keep the Discord token block in the private runtime env file and remove the Telegram token block if you are not running
Telegram. Then start the container:

```bash
docker compose up -d --build
docker compose logs -f opencode-bridge
```

Smoke test from the configured Discord control channel:

```text
/oc status
/oc sessions
/oc new Discord smoke test
/oc prompt what repository are you running in?
/oc abort
```

Slash commands do not need Discord's Message Content privileged intent. Enable Message Content only if you want `!oc ...`
prefix commands or plain-text guild replies, then set `OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT=1` in the private
runtime env.

## Telegram setup

Create a Telegram bot through BotFather, then send the bot one message from the chat you want to allow. Use the bot token
to inspect the update payload and copy the numeric `from.id` and `chat.id` values:

```bash
export OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN="123456789:replace-with-real-token"
curl -s "https://api.telegram.org/bot${OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN}/getUpdates"
```

Use those values in the bridge runtime env file:

```bash
OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN=123456789:replace-with-real-token
OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS=123456789
OPENCODE_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS=123456789
OPENCODE_BRIDGE_TELEGRAM_CREATE_TOPICS=0
OPENCODE_BRIDGE_IMPLICIT_REPLY=0
```

`OPENCODE_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS` is technically optional, but keep it set on a server. Without it, any chat
from an allowlisted user can control the bridge.

Set `OPENCODE_BRIDGE_TELEGRAM_CREATE_TOPICS=1` if `/oc new ...` should create a Telegram topic and bind the new OpenCode
session to that returned `message_thread_id`. The bridge only attempts this when the command is not already inside a
Telegram thread and the chat type is `private` or `supergroup`. If Telegram rejects the topic creation, for example because
the supergroup is not a forum or the bot lacks `can_manage_topics`, the session is still created and bound to the current
chat instead.

If the bot was previously configured with a webhook, remove it before using long polling:

```bash
curl -s -X POST "https://api.telegram.org/bot${OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN}/deleteWebhook"
```

On the first poll, the bridge calls Telegram `setMyCommands` so the bot menu exposes `/status`, `/sessions`, `/attach`,
`/new`, `/prompt`, `/reply`, and `/abort`. The older `/oc ...` form still works, which is useful in groups where you want
one command namespace. Bridge-generated responses use Telegram MarkdownV2 and successful commands get a best-effort
reaction. Reaction failures from Telegram are ignored so command handling still completes.

For assistant output, the bridge uses Telegram's newer AI-agent path where it can. Private chats receive ephemeral
`sendMessageDraft` updates while OpenCode is still generating, followed by a final persisted `sendMessage` when the session
goes idle. Groups and supergroups use a normal bot message as a preview, then update that message with `editMessageText` as
more text arrives. In both paths the final text is MarkdownV2-escaped before sending.

### Telegram smoke test

Send these messages to the allowlisted Telegram chat:

```text
/oc status
/status
/oc new Docker bridge smoke test
/oc prompt what repository are you running in?
/oc abort
```

Expected result:

- `/oc status` reports OpenCode health and the active session.
- `/status` works from Telegram's command menu and returns the same status response.
- `/oc new` creates and binds a session to that Telegram chat.
- If `OPENCODE_BRIDGE_TELEGRAM_CREATE_TOPICS=1`, `/oc new` creates a Telegram topic first and binds the session to that
  topic. Existing topic commands keep binding to the topic they were sent from.
- `/oc prompt` sends text to the bound OpenCode session.
- Assistant text is relayed back into Telegram from the OpenCode event stream using MarkdownV2-safe escaping. Private chats
  should show draft-style streaming while generation is in progress; groups should see a bot message update in place.

## Discord setup

Create a Discord application and bot in the Discord Developer Portal, then invite the bot to a private control channel.
Use the `bot` and `applications.commands` scopes. These bot permissions are enough for the daemon path:

- `Read Messages/View Channels`
- `Send Messages`
- `Read Message History`
- `Use Slash Commands`

Leave the application's Interactions Endpoint URL empty if you want slash commands delivered over the Gateway. Discord's
Gateway and outgoing-webhook interaction delivery modes are mutually exclusive.

Enable the Message Content privileged intent only if you want `!oc ...` prefix commands or plain-text replies in guild
channels. Slash commands do not need that privileged intent. If you enable it in the Developer Portal, also set
`OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT=1` in the bridge env.

Set the required Discord environment before starting the bridge:

```bash
export OPENCODE_BRIDGE_DISCORD_BOT_TOKEN="replace-with-real-token"
export OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS="123456789012345678"
```

Useful optional settings:

```bash
export OPENCODE_BRIDGE_DISCORD_APPLICATION_ID="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_GUILD_ID="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_REGISTER_SLASH_COMMANDS="1"
export OPENCODE_BRIDGE_DISCORD_SLASH_COMMAND="oc"
export OPENCODE_BRIDGE_DISCORD_PREFIX="!oc"
export OPENCODE_BRIDGE_DISCORD_SLASH_EPHEMERAL="1"
export OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT="0"
export OPENCODE_BRIDGE_IMPLICIT_REPLY="0"
```

`OPENCODE_BRIDGE_DISCORD_GUILD_ID` makes command registration guild-scoped, which updates quickly and is better while
testing. If it is unset, registration is global and Discord may take longer to show the command. The daemon caches the
registered command signature in bridge state so normal reconnects do not repeatedly upsert the command.

Start the local Discord daemon after those variables and the OpenCode target from [Local setup](#local-setup) are set. From
the repo root:

```bash
just opencode-bridge discord
```

Or from this package directory:

```bash
yarn start discord
```

Then smoke test from Discord:

```text
/oc status
/oc sessions
/oc new Discord smoke test
/oc prompt what repository are you running in?
/oc abort
```

If you enabled `OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT=1`, prefix commands work too:

```text
!oc status
!oc new Discord daemon smoke test
!oc prompt what repository are you running in?
```

Expected result:

- `/oc status` reports OpenCode health and the active Discord channel session.
- `/oc new` creates and binds a session to that Discord channel.
- `/oc prompt` sends text to the bound OpenCode session.
- Assistant text is relayed back into Discord from the OpenCode event stream.

Plugin-specific details for the older OpenCode plugin live in `../../plugins/opencode/discord-remote-control.md`.

## Local setup

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
export OPENCODE_BRIDGE_TELEGRAM_CREATE_TOPICS="0"         # optional, set to 1 for per-session topics
```

For Discord, set the bot token, control channel, and allowlisted users instead:

```bash
export OPENCODE_BRIDGE_DISCORD_BOT_TOKEN="..."
export OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS="123456789012345678"
export OPENCODE_BRIDGE_DISCORD_APPLICATION_ID="123456789012345678" # needed for slash registration before READY
export OPENCODE_BRIDGE_DISCORD_GUILD_ID="123456789012345678"       # optional, but useful while testing
export OPENCODE_BRIDGE_DISCORD_REGISTER_SLASH_COMMANDS="1"
```

## Commands

```bash
yarn start status
yarn start sessions
yarn start new "Session title"
yarn start telegram-once
yarn start telegram
yarn start discord-once
yarn start discord
yarn start telegram+discord-once
yarn start telegram+discord
yarn check
```

`telegram-once` processes one `getUpdates` response and exits. Use it for inbound smoke tests and service debugging.
`telegram` runs the same poller continuously and also subscribes to OpenCode server-sent events so bound session output
can be sent back to Telegram.

`discord-once` connects to the Discord Gateway once and exits when the socket closes. Use it for debugging Gateway and
slash-command setup. `discord` reconnects continuously and also subscribes to OpenCode server-sent events so bound session
output can be sent back to Discord.

`telegram+discord-once` runs one Telegram poll and one Discord Gateway cycle. `telegram+discord` runs both surfaces in one
bridge process with one managed `opencode serve` process and one OpenCode event relay for both Telegram and Discord
bindings. Keep both token blocks in the runtime env file when you use the combined command.

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

### Docker Compose

Docker Compose is the preferred server path for the Telegram or Discord bridge.

Fast path if you just want one file to edit:

```bash
just opencode-bridge-config
cp compose.example.yaml compose.local.yaml
$EDITOR compose.local.yaml
docker compose -f compose.local.yaml up -d --build
docker compose -f compose.local.yaml logs -f opencode-bridge
```

`compose.local.yaml` is ignored by git. The example defaults to `telegram+discord`; change the command if you only want
one surface. Put the real Discord or Telegram token values there if you use this path.

Build a Docker-safe OpenCode config directory first. This copies your OpenCode config with symlinks resolved, so the
container does not need a `llmfiles` mount:

```bash
just opencode-bridge-config
```

Copy the Compose interpolation example and edit the host paths:

```bash
cp .env.example .env
$EDITOR .env
```

Create the private runtime env file referenced by `.env`:

```bash
mkdir -p "$HOME/.config/opencode-messaging-bridge"
cp bridge.env.example "$HOME/.config/opencode-messaging-bridge/env"
$EDITOR "$HOME/.config/opencode-messaging-bridge/env"
```

Set `OPENCODE_BRIDGE_COMMAND` in `.env` to the surface you want the container to run:

```bash
OPENCODE_BRIDGE_COMMAND=telegram
# or
OPENCODE_BRIDGE_COMMAND=discord
# or
OPENCODE_BRIDGE_COMMAND=telegram+discord
```

In the runtime env file, remove the token block for any surface you are not running. Keep both token blocks when
`OPENCODE_BRIDGE_COMMAND=telegram+discord`. The example shows both blocks so the available keys are visible, not because
both are always required.

For `bsociety`, set this in `.env`:

```bash
OPENCODE_BRIDGE_PROJECT_DIR=/home/kieran/dev/bsociety
OPENCODE_BRIDGE_CONFIG_DIR=/home/kieran/.config/opencode-messaging-bridge/opencode-config
```

Check the Compose shape with the example env before using real tokens:

```bash
OPENCODE_BRIDGE_RUNTIME_ENV_FILE=./bridge.env.example docker compose --env-file .env.example config
```

Do not run `docker compose config` against the real runtime env unless you are happy for bot tokens to appear in your
terminal scrollback.

Start the bridge:

```bash
docker compose up -d --build
docker compose logs -f opencode-bridge
```

You can also override the command for one Compose invocation without editing `.env`:

```bash
OPENCODE_BRIDGE_COMMAND=discord docker compose up -d --build
```

Stop or restart it:

```bash
docker compose restart opencode-bridge
docker compose down
```

The Compose file deliberately does not publish port `4096`. OpenCode stays on `127.0.0.1` inside the container.

### Raw Docker

Create an untracked environment file on the host. Do not commit this file.

```bash
mkdir -p "$HOME/.config/opencode-messaging-bridge"
$EDITOR "$HOME/.config/opencode-messaging-bridge/env"
```

Use this shape:

```bash
OPENCODE_BRIDGE_DISCORD_BOT_TOKEN=replace-with-real-token
OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID=123456789012345678
OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS=123456789012345678
OPENCODE_BRIDGE_DISCORD_APPLICATION_ID=123456789012345678
OPENCODE_BRIDGE_DISCORD_GUILD_ID=123456789012345678
OPENCODE_BRIDGE_DISCORD_REGISTER_SLASH_COMMANDS=1
OPENCODE_BRIDGE_MANAGE_OPENCODE=1
OPENCODE_BRIDGE_OPENCODE_HOST=127.0.0.1
OPENCODE_BRIDGE_OPENCODE_PORT=4096
```

Run the container with secrets, OpenCode credentials, the target project, and bridge state mounted at runtime:

```bash
docker run -d \
  --name opencode-bridge \
  --restart unless-stopped \
  --env-file "$HOME/.config/opencode-messaging-bridge/env" \
  -e OPENCODE_BRIDGE_OPENCODE_WORKDIR="/workspace/project" \
  -v "$HOME/.local/share/opencode:/home/node/.local/share/opencode" \
  -v "$HOME/.config/opencode-messaging-bridge/opencode-config:/home/node/.config/opencode:ro" \
  -v "/home/kieran/dev/bsociety:/workspace/project" \
  -v opencode-bridge-state:/state \
  opencode-messaging-bridge \
  yarn start discord
```

Replace `/home/kieran/dev/bsociety` with the repo you want OpenCode to control. The path inside the container must
match `OPENCODE_BRIDGE_OPENCODE_WORKDIR`.

Check the logs:

```bash
docker logs -f opencode-bridge
```

The bridge state lives in the `opencode-bridge-state` Docker volume because the image sets `XDG_STATE_HOME=/state`.
That state stores Telegram offsets, Discord Gateway resume metadata, slash-command registration signatures, and
chat/channel-to-session bindings. It must not contain bot tokens or OpenCode credentials.

OpenCode provider credentials are separate. OpenCode stores credentials created through `/connect` in
`~/.local/share/opencode/auth.json`, so ChatGPT Plus/Pro and OpenCode Go credentials should be prepared on the host and
mounted into the container at runtime. OAuth-style credentials may need write access for token refresh; if you do not want
the container writing to your host auth directory, copy the OpenCode auth directory into a private Docker volume and mount
that instead. OpenCode config is separate: run `just opencode-bridge-config` after changing repo-managed agents, commands,
skills, or plugins, then mount the resolved config directory read-only.

### Stop or restart

```bash
docker restart opencode-bridge
docker rm -f opencode-bridge
```

Do not publish `4096` from the container unless the bridge gains OpenCode basic-auth client support. For now, keep
OpenCode on `127.0.0.1` inside the container and let Telegram or Discord be the remote control surface.
