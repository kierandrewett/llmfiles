# OpenCode messaging bridge

Standalone daemon for controlling OpenCode sessions from Telegram or Discord.

This package implements the standalone bridge described in `../../docs/opencode-messaging-bridge.md`:

- environment config parsing
- atomic JSON state storage
- OpenCode HTTP client for health checks, session listing, session creation, prompt sends, aborts, permission replies, and scheduled prompt runs
- Telegram Bot API long polling, command-menu registration, reactions, MarkdownV2 text responses, and streaming previews
- Discord Gateway, REST, slash-command, and prefix-command handling
- allowlisted Telegram command routing for `/oc ...` subcommands and first-class menu commands such as `/status`,
  `/sessions`, `/attach`, `/new`, `/prompt`, `/reply`, `/abort`, `/jobs`, `/schedule`, `/unschedule`, `/run_now`,
  `/allow`, `/always`, and `/deny`
- OpenCode server-sent event relay for bound Telegram and Discord sessions, including Telegram draft/edit previews for
  assistant text parts, permission prompts, tool status updates, and session errors
- opt-in OpenRouter voice transcription for Telegram voice/audio messages and Discord audio attachments
- opt-in workspace intent resolution for short plain-text Telegram and Discord requests
- optional OpenCode process supervision for `opencode serve`
- CLI commands for checking the configured OpenCode server and running Telegram or Discord daemon loops

OpenCode stays the agent. The bridge only forwards prompts, relays session output, and routes OpenCode permission requests
back to the OpenCode server.

## Contents

- [How Docker control works](#how-docker-control-works)
- [Control surface support](#control-surface-support)
- [Discord quickstart](#discord-quickstart)
- [Telegram setup](#telegram-setup)
- [Discord setup](#discord-setup)
- [Local setup](#local-setup)
- [Voice transcription](#voice-transcription)
- [Workspace intent resolver](#workspace-intent-resolver)
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
platform, whichever model provider OpenCode uses, and OpenRouter if voice transcription is enabled. Telegram uses Bot API
long polling. Discord uses a Gateway WebSocket for inbound messages and interactions, plus REST calls for responses. The
bridge sends prompts to OpenCode, then relays assistant text back to the bound chat or channel.

## Control surface support

| Surface | Runtime | Status |
| --- | --- | --- |
| Telegram | Standalone bridge app, Docker, or Docker Compose | Implemented here |
| Discord | Standalone bridge app, Docker, or Docker Compose | Implemented here |

The older `plugins/opencode/discord-remote-control.ts` plugin still exists and has extra plugin-specific behaviour such as
session threads and forum intake. The standalone daemon is now the proper Docker/server path for core Discord control:
`status`, `sessions`, `attach`, `new`, `prompt`, `reply`, `abort`, scheduled prompts, permission replies, and assistant
text relay.

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

For Docker Compose, build the resolved OpenCode config, then copy and edit the one-file example from this package
directory:

```bash
just opencode-bridge-config
cp compose.example.yaml compose.local.yaml
$EDITOR compose.local.yaml
```

Set the command in `compose.local.yaml` if you only want Discord:

```yaml
command: ["yarn", "start", "discord"]
```

Keep the Discord token block in `compose.local.yaml` and remove or blank the Telegram token block if you are not running
Telegram. Then start the container:

```bash
docker compose -f compose.local.yaml up -d --build
docker compose -f compose.local.yaml logs -f opencode-bridge
```

Smoke test from the configured Discord control channel:

```text
/oc status
/oc sessions
/oc new Discord smoke test
/oc prompt what repository are you running in?
/oc schedule every 30m summarise the current repo status
/oc jobs
/oc allow per_123
/oc abort
```

Slash commands do not need Discord's Message Content privileged intent. Enable Message Content only if you want `!oc ...`
prefix commands or plain-text guild replies, then set `OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT=1` in your local
environment or `compose.local.yaml`.

## Telegram setup

Create a Telegram bot through BotFather, then send the bot one message from the chat you want to allow. Use the bot token
to inspect the update payload and copy the numeric `from.id` and `chat.id` values:

```bash
export OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN="123456789:replace-with-real-token"
curl -s "https://api.telegram.org/bot${OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN}/getUpdates"
```

Use those values in your local environment or `compose.local.yaml`:

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
`/new`, `/prompt`, `/reply`, `/abort`, `/jobs`, `/schedule`, `/unschedule`, `/run_now`, `/allow`, `/always`, and `/deny`.
The older `/oc ...` form still works, which is useful in groups where you want one command namespace. Bridge-generated
responses use Telegram MarkdownV2 and successful commands get a best-effort reaction. Reaction failures from Telegram are
ignored so command handling still completes.

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
/oc schedule every 30m summarise the current session state
/oc jobs
/oc allow per_123
/oc abort
```

Expected result:

- `/oc status` reports OpenCode health and the active session.
- `/status` works from Telegram's command menu and returns the same status response.
- `/oc new` creates and binds a session to that Telegram chat.
- If `OPENCODE_BRIDGE_TELEGRAM_CREATE_TOPICS=1`, `/oc new` creates a Telegram topic first and binds the session to that
  topic. Existing topic commands keep binding to the topic they were sent from.
- `/oc prompt` sends text to the bound OpenCode session.
- If voice transcription is enabled, a voice or audio message in the bound chat is transcribed and sent to that same
  OpenCode session.
- `/oc schedule every 30m ...` creates a durable scheduled prompt for the session that is active in this chat.
- `/oc jobs`, `/oc run-now <job-id>`, and `/oc unschedule <job-id>` inspect, run, and remove scheduled prompts for this chat.
- When OpenCode emits a permission prompt for the bound session, the bridge posts the permission ID and the reply commands:
  `/oc allow <permission-id>`, `/oc always <permission-id>`, or `/oc deny <permission-id> [feedback]`.
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
`OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT=1` in your local environment or `compose.local.yaml`.

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
/oc schedule every 30m summarise the current session state
/oc jobs
/oc allow per_123
/oc abort
```

If you enabled `OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT=1`, prefix commands work too:

```text
!oc status
!oc new Discord daemon smoke test
!oc prompt what repository are you running in?
!oc schedule every 30m summarise the current session state
!oc deny per_123 not safe
```

Expected result:

- `/oc status` reports OpenCode health and the active Discord channel session.
- `/oc new` creates and binds a session to that Discord channel.
- `/oc prompt` sends text to the bound OpenCode session.
- If voice transcription is enabled, an audio attachment in the bound channel is transcribed and sent to that same
  OpenCode session.
- `/oc schedule every 30m ...` creates a durable scheduled prompt for the session that is active in this channel.
- `/oc jobs`, `/oc run-now <job-id>`, and `/oc unschedule <job-id>` inspect, run, and remove scheduled prompts for this channel.
- When OpenCode emits a permission prompt for the bound session, the bridge posts the permission ID and the reply commands:
  `/oc allow <permission-id>`, `/oc always <permission-id>`, or `/oc deny <permission-id> [feedback]`.
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

## Workspace intent resolver

The workspace intent resolver is disabled by default. When enabled, short plain-text messages from allowlisted users are
sent to a hidden OpenCode resolver session first. The resolver returns one of three outcomes:

- a resolved workspace path and prompt, which creates a real OpenCode session under `OPENCODE_BRIDGE_WORKSPACE_ROOT`
- a clarification question, shown as Telegram inline buttons or a Discord select menu
- a cannot-resolve reason, sent back to the chat or channel

Enable it only when the bridge can see the repository root it is allowed to choose from:

```bash
export OPENCODE_BRIDGE_WORKSPACE_ROOT="/workspace"
export OPENCODE_BRIDGE_INTENT_RESOLVER="1"
export OPENCODE_BRIDGE_INTENT_RESOLVER_MAX_TURNS="4"
export OPENCODE_BRIDGE_INTENT_RESOLVER_TTL_MS="600000"
```

Rules:

- `OPENCODE_BRIDGE_WORKSPACE_ROOT` must be an absolute path.
- Resolved paths must stay under that root.
- Clarification state is stored in `state.json`, but tokens, OpenRouter keys, and OpenCode credentials are not.
- Telegram plain text can start or continue a resolver flow without extra platform permissions.
- Discord plain text needs Message Content intent enabled in Discord and `OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT=1`.
- Discord component selections and slash commands do not need Message Content intent.
- Long commands such as `/oc prompt ...` and `!oc prompt ...` remain available as explicit escape hatches.

For Docker Compose, keep `OPENCODE_BRIDGE_WORKSPACE_ROOT=/workspace` and mount each repo the resolver may use under
`/workspace`. If you only mount one repo at `/workspace/project`, the resolver can only safely create sessions in that repo
or its children.

## Voice transcription

Voice transcription is disabled by default. When enabled, the bridge accepts Telegram voice/audio messages and Discord
audio attachments from allowlisted users, transcribes the audio through OpenRouter, and sends the resulting text as a
normal prompt to the active OpenCode session for that chat, topic, or channel.

Enable it only in an untracked runtime environment or in `compose.local.yaml`:

```bash
export OPENCODE_BRIDGE_VOICE_TRANSCRIPTION="1"
export OPENCODE_BRIDGE_OPENROUTER_API_KEY="replace-with-real-openrouter-key"
```

Optional settings:

```bash
export OPENCODE_BRIDGE_OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
export OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_MODEL="openai/whisper-1"
export OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_LANGUAGE="en" # optional ISO-639-1 hint
export OPENCODE_BRIDGE_VOICE_MAX_AUDIO_BYTES="20971520"
```

The bridge calls OpenRouter's `POST /audio/transcriptions` endpoint with JSON containing `model`, base64 `input_audio`,
the detected audio `format`, and the optional `language` hint. OpenRouter documents that endpoint here:
https://openrouter.ai/docs/api/api-reference/transcriptions/create-audio-transcriptions.

Operational rules:

- `OPENCODE_BRIDGE_OPENROUTER_API_KEY` is required only when `OPENCODE_BRIDGE_VOICE_TRANSCRIPTION=1`.
- OpenRouter keys are read from env/config only. They are not written to the bridge state file.
- Audio is accepted only after the normal Telegram or Discord allowlist check and only when the surface has an active
  OpenCode session.
- Discord attachment downloads must use HTTPS. Telegram downloads go through the Bot API `getFile` path.
- Supported formats are `wav`, `mp3`, `flac`, `m4a`, `ogg`, `webm`, and `aac`.
- The default maximum audio size is 20 MiB. Lower it with `OPENCODE_BRIDGE_VOICE_MAX_AUDIO_BYTES` if you want a smaller
  cost and latency ceiling.

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
yarn start automation-once
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
bindings. Keep both token blocks in your local environment or `compose.local.yaml` when you use the combined command.

`automation-once` runs due scheduled prompts once and exits. The continuous `telegram`, `discord`, and `telegram+discord`
commands run the same scheduler loop every 30 seconds. Each scheduled prompt targets the OpenCode session that was active
when the job was created. Missed intervals do not catch up in a burst after downtime; the next run is calculated from the
time the job is processed.

Chat commands for schedules:

```text
/oc schedule every 30m summarise the current session state
/oc jobs
/oc run-now job_20260509T000000000Z_1
/oc unschedule job_20260509T000000000Z_1
```

Durations support `m`, `h`, and `d`, with a minimum of `5m` and a maximum of `7d`. Discord prefix commands use the same
arguments, for example `!oc schedule every 2h check for failed tests`.

The state file defaults to:

```text
$XDG_STATE_HOME/opencode-messaging-bridge/state.json
```

If `XDG_STATE_HOME` is not set, it falls back to:

```text
$HOME/.local/state/opencode-messaging-bridge/state.json
```

The state file stores routing state, scheduled prompt jobs, and platform resume metadata only. Do not put tokens, OpenCode
passwords, API keys, or other secrets in it.

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

Build a Docker-safe OpenCode config directory first. This copies your OpenCode config with symlinks resolved, so the
container does not need a `llmfiles` mount:

```bash
just opencode-bridge-config
```

Copy the one-file example and edit the placeholders:

```bash
cp compose.example.yaml compose.local.yaml
$EDITOR compose.local.yaml
```

`compose.local.yaml` is ignored by git. The example defaults to `telegram+discord`; change the command if you only want
one surface:

```yaml
command: ["yarn", "start", "discord"]
# or
command: ["yarn", "start", "telegram"]
# or
command: ["yarn", "start", "telegram+discord"]
```

In `compose.local.yaml`:

- replace the Telegram and Discord token/id placeholders for the surfaces you run
- remove or blank the unused platform block if you only run one surface
- replace the host project mount, keeping `/workspace/project` as the container path
- keep OpenCode auth mounted from `~/.local/share/opencode`, or replace that mount with a private Docker volume if you do
  not want token refresh writing to the host auth directory
- leave voice transcription disabled, or set `OPENCODE_BRIDGE_VOICE_TRANSCRIPTION=1` and add the OpenRouter key only in
  `compose.local.yaml`

Start the bridge:

```bash
docker compose -f compose.local.yaml up -d --build
docker compose -f compose.local.yaml logs -f opencode-bridge
```

Stop or restart it:

```bash
docker compose -f compose.local.yaml restart opencode-bridge
docker compose -f compose.local.yaml down
```

Check the example shape before using real tokens:

```bash
docker compose -f compose.example.yaml config
```

Do not run `docker compose config` against `compose.local.yaml` unless you are happy for bot tokens or OpenRouter keys to
appear in your terminal scrollback.

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
OPENCODE_BRIDGE_VOICE_TRANSCRIPTION=0
```

If you enable voice transcription, add `OPENCODE_BRIDGE_OPENROUTER_API_KEY` to the same untracked env file.

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
That state stores Telegram offsets, Discord Gateway resume metadata, slash-command registration signatures,
chat/channel-to-session bindings, and scheduled prompt jobs. It must not contain bot tokens, OpenCode credentials, or
OpenRouter keys.

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
