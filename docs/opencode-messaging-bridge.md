# OpenCode messaging bridge plan

Status: design note with Phase 1, Telegram command routing/output, Discord Gateway/REST command routing/output, richer
OpenCode event relay, bridge-native permission replies, scheduled prompt automation, optional managed OpenCode process
support, and Docker Compose runtime support in place, May 2026.

This document defines a standalone, always-on messaging bridge for OpenCode. It is the next step after the Discord remote-control plugin prototype. The plugin proved the UX and the platform edge cases, but it also showed the wrong lifecycle: a plugin attached to an OpenCode worker can exit before slow Discord retries, thread recovery, or cross-platform routing has finished.

The bridge should run as its own daemon and treat OpenCode, Telegram, and Discord as peers connected through explicit adapters.

## Goals

- Keep OpenCode sessions reachable from Telegram and Discord.
- Let a messaging platform create a new OpenCode session.
- Let a messaging platform attach to an existing manually-created OpenCode session.
- Relay OpenCode assistant text, reasoning parts exposed by OpenCode, important tool events, permission requests, and errors back to the mapped platform surface.
- Let an allowlisted user schedule repeated prompts against an explicitly bound OpenCode session.
- Keep platform-specific state durable across daemon restarts.
- Avoid storing secrets in state or git.
- Avoid relying on Discord creating a large number of threads.
- Preserve the current Discord safety model: allowlisted users only and no outbound mentions.

## Non-goals for the first build

- No multi-user authorisation model beyond allowlists.
- No public bot mode.
- No hosted web dashboard.
- No automatic migration of every existing Discord thread binding until the core daemon works.
- No Telegram webhook first. Long polling is simpler for a local daemon and avoids needing an HTTPS endpoint.
- No dependence on Discord forum threads for session identity. Threads can remain an optional explicit binding, not the default session model.

## Source checks

These are the source-backed facts the design relies on.

- OpenCode can run as a headless HTTP server with `opencode serve --port <number> --hostname <string>` and exposes an OpenAPI endpoint at `/doc`.
  Source: https://opencode.ai/docs/server/
- OpenCode's CLI documents `serve` as the headless API server command and supports `--port` and `--hostname` flags.
  Source: https://opencode.ai/docs/cli/
- OpenCode provider credentials added through `/connect` are stored in `~/.local/share/opencode/auth.json`, including
  ChatGPT Plus/Pro and OpenCode Go credentials.
  Source: https://opencode.ai/docs/providers/
- OpenCode's SDK can either start a server with `createOpencode()` or connect to an existing one with `createOpencodeClient({ baseUrl })`.
  Source: https://opencode.ai/docs/sdk/
- OpenCode session APIs cover list, create, update, messages, async prompt, abort, and permission response flows.
  Source: https://opencode.ai/docs/sdk/ and local SDK types from `@opencode-ai/sdk@1.3.17`.
- OpenCode event subscription is available as a server-sent events stream at `GET /event`. The bridge should use typed
  `message.part.updated` events for transcript output rather than raw deltas where possible.
  Source: https://opencode.ai/docs/server/ and https://opencode.ai/docs/sdk/
- Telegram Bot API is HTTP-based. Bots can receive updates by either `getUpdates` long polling or webhooks, and the two modes are mutually exclusive.
  Source: https://core.telegram.org/bots/api#getting-updates
- Telegram `getUpdates` uses a durable `offset`; to avoid duplicate updates the client recalculates the offset after every server response.
  Source: https://core.telegram.org/bots/api#getupdates
- Telegram `sendMessage` sends text and supports `chat_id`, optional `message_thread_id`, and 1-4096 characters after entity parsing.
  Source: https://core.telegram.org/bots/api#sendmessage
- Telegram `sendChatAction` can show typing for noticeable waits and is cleared when the bot sends a message.
  Source: https://core.telegram.org/bots/api#sendchataction
- Node's `child_process.spawn()` starts a child process asynchronously with explicit arguments and no shell by default;
  the bridge uses this for `opencode serve` instead of shell command strings.
  Source: https://nodejs.org/download/release/v22.13.1/docs/api/child_process.html#child_processspawncommand-args-options
- Node emits signal events such as `SIGINT` and `SIGTERM`; cleanup hooks should remain explicit when the long-running
  daemon gains full shutdown orchestration.
  Source: https://nodejs.org/download/release/v22.13.1/docs/api/process.html#signal-events
- Discord Gateway requires a persistent WebSocket, heartbeats, sequence tracking, reconnect/resume handling, and intents.
  Source: https://discord.com/developers/docs/topics/gateway
- Discord message content is privileged for guild messages. Slash commands, DMs, and app mentions reduce the need for raw guild message content.
  Source: https://discord.com/developers/docs/topics/gateway#message-content-intent
- Discord outbound messages must continue to set `allowed_mentions: { parse: [] }` to prevent tool or model text from pinging users, roles, `@here`, or `@everyone`.
  Source: current plugin safety model in `plugins/opencode/discord-remote-control.md`.

## Architecture

```text
Telegram Bot API          Discord Gateway/REST
      |                          |
      v                          v
  TelegramAdapter          DiscordAdapter
      |                          |
      +------------+-------------+
                   |
                   v
             BridgeRouter
                   |
          +--------+--------+
          |                 |
          v                 v
   OpenCodeAdapter     BridgeStore
          |                 |
          v                 v
  OpenCode HTTP/SSE     state.json
```

The daemon should be split into five boundaries.

### BridgeRouter

The router is the platform-neutral coordinator.

Responsibilities:

- Normalise inbound Telegram and Discord messages into one `BridgeInbound` shape.
- Authorise inbound messages against platform-specific allowlists.
- Resolve which OpenCode session an inbound message targets.
- Create sessions when requested.
- Attach platform surfaces to existing sessions.
- Send prompts to OpenCode.
- Convert OpenCode events into platform-neutral `BridgeOutbound` messages.
- Fan out each OpenCode event to every bound platform surface for that session.
- Persist mapping and delivery state through `BridgeStore` before acknowledging durable platform offsets where practical.

### OpenCodeAdapter

The OpenCode adapter owns all OpenCode SDK and HTTP details.

Responsibilities:

- Connect to a configured OpenCode server URL, or optionally spawn a local `opencode serve` process.
- Check health on start.
- List sessions and statuses.
- Create sessions with title, directory, model, agent, variant, and permission rules where supported.
- Send prompts using async prompt APIs so the bridge process is not blocked waiting for a full assistant response.
- Subscribe to OpenCode events through SSE.
- Fetch recent messages for catch-up after bridge restart.
- Reply to permission requests using the non-deprecated permission reply endpoint where available.

Important design point: the daemon still defaults to an explicit OpenCode server URL. Managed `opencode serve` is opt-in
through `OPENCODE_BRIDGE_MANAGE_OPENCODE=1`, which keeps the original external-server workflow intact while making the
Docker/service path self-contained.

### PlatformAdapter

Each platform adapter should implement the same small interface.

```ts
interface PlatformAdapter {
    readonly platform: "telegram" | "discord";
    start(handler: PlatformInboundHandler): Promise<void>;
    stop(): Promise<void>;
    send(message: BridgeOutbound): Promise<PlatformDelivery>;
    mark(message: BridgeMark): Promise<void>;
}
```

The exact TypeScript can change during implementation, but the boundary should stay small. The router should not know whether Telegram uses long polling or Discord uses a Gateway. The platform adapter should not know how OpenCode sessions are created.

### BridgeStore

The store should be a single JSON file first, written atomically.

Default path:

```text
$XDG_STATE_HOME/opencode-messaging-bridge/state.json
```

Fallback path:

```text
$HOME/.local/state/opencode-messaging-bridge/state.json
```

The file should store durable routing and offset data only. It must not store bot tokens, OpenCode passwords, API keys, user secrets, or configuration values such as the OpenCode base URL. Platform IDs should be stored as strings, even when the platform represents them as numbers, so Discord snowflakes and Telegram chat IDs stay lossless.

Draft schema:

```json
{
  "version": 1,
  "updatedAt": "2026-05-09T00:00:00.000Z",
  "platforms": {
    "telegram": {
      "updateOffset": null
    },
    "discord": {
      "gatewaySessionID": null,
      "resumeGatewayUrl": null,
      "sequence": null
    }
  },
  "surfaces": [
    {
      "id": "telegram:12345:",
      "platform": "telegram",
      "surface": {
        "chatID": "12345",
        "threadID": null
      },
      "activeSessionID": "ses_abc",
      "updatedAt": "2026-05-09T00:00:00.000Z"
    }
  ],
  "bindings": [
    {
      "id": "telegram:12345:ses_abc",
      "platform": "telegram",
      "surface": {
        "chatID": "12345",
        "threadID": null
      },
      "sessionID": "ses_abc",
      "directory": "/home/kieran/dev/lifeos-scrubbed",
      "title": "Session title",
      "createdAt": "2026-05-09T00:00:00.000Z",
      "updatedAt": "2026-05-09T00:00:00.000Z"
    }
  ],
  "jobs": [
    {
      "id": "job_20260509T000000000Z_1",
      "platform": "telegram",
      "surfaceID": "telegram:12345:",
      "surface": {
        "chatID": "12345",
        "threadID": null
      },
      "sessionID": "ses_abc",
      "prompt": "summarise the current session state",
      "intervalMinutes": 30,
      "nextRunAt": "2026-05-09T00:30:00.000Z",
      "lastRunAt": null,
      "lastError": null,
      "createdAt": "2026-05-09T00:00:00.000Z",
      "updatedAt": "2026-05-09T00:00:00.000Z"
    }
  ],
  "deliveries": []
}
```

`jobs` is optional when reading old state files and defaults to an empty list. `deliveries` can start as an empty array and
become a bounded outbox if platform sends need retry. The important part is that platform offsets, scheduled jobs, and
session bindings are not held only in memory.

### ConfigLoader

Configuration should come from environment variables or a local untracked config file. The source-of-truth repo can document variable names, but should not contain values.

Suggested environment:

```bash
export OPENCODE_BRIDGE_OPENCODE_BASE_URL="http://127.0.0.1:4096"
export OPENCODE_BRIDGE_MANAGE_OPENCODE="0"
export OPENCODE_BRIDGE_OPENCODE_COMMAND="opencode"
export OPENCODE_BRIDGE_OPENCODE_HOST="127.0.0.1"
export OPENCODE_BRIDGE_OPENCODE_PORT="4096"
export OPENCODE_BRIDGE_OPENCODE_WORKDIR="/path/to/project"
export OPENCODE_BRIDGE_OPENCODE_STARTUP_TIMEOUT_MS="30000"
export OPENCODE_BRIDGE_STATE_PATH="$HOME/.local/state/opencode-messaging-bridge/state.json"

export OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN="..."
export OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS="12345"
export OPENCODE_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS="12345"

export OPENCODE_BRIDGE_DISCORD_BOT_TOKEN="..."
export OPENCODE_BRIDGE_DISCORD_APPLICATION_ID="..."
export OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS="..."
export OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID="..."
```

Secrets stay out of the state file and out of git. For container runs, mount OpenCode's auth/config directories and pass
bridge tokens with `--env-file`, Docker secrets, or another runtime secret mechanism. ChatGPT Plus/Pro and OpenCode Go
credentials should come from the OpenCode auth file generated by `/connect`, not from committed env examples. Auth mounts
may need write access for OAuth token refresh, so use a private Docker volume if writing to the host auth directory is not
acceptable.

## Platform UX

### Telegram first path

Telegram should be the first standalone adapter because the Bot API polling model is simple and deterministic.

MVP commands:

- `/oc status` - show daemon health, OpenCode health, active session, and bound sessions.
- `/oc sessions` - list recent OpenCode sessions.
- `/oc attach latest` - bind this chat or topic to the latest OpenCode session.
- `/oc attach <session-id>` - bind this chat or topic to one session.
- `/oc new [title]` - create a new session and bind this chat or topic.
- `/oc prompt <text>` or `/oc reply <text>` - send a prompt to the bound session.
- `/oc abort` - abort the bound session.
- `/oc jobs` - list scheduled prompts for this chat or topic.
- `/oc schedule every <duration> <text>` - schedule a prompt for the active session.
- `/oc run-now <job-id>` - run a scheduled prompt immediately.
- `/oc unschedule <job-id>` - remove a scheduled prompt.
- `/oc allow <request-id>`, `/oc always <request-id>`, `/oc deny <request-id>` - answer permission requests.

Plain text can be treated as a reply only when exactly one session is bound to the chat or topic and `OPENCODE_BRIDGE_IMPLICIT_REPLY=1` is set. Otherwise the bridge should ask for an explicit `/oc attach` or `/oc reply`.

Telegram output rules:

- Chunk messages to stay below the 4096-character `sendMessage` limit.
- Use `message_thread_id` when the inbound message came from a Telegram forum topic.
- Use `sendChatAction` with `typing` for noticeable waits, not as a constant heartbeat.
- Avoid `parse_mode` in MVP to prevent accidental formatting or entity parsing issues from model/tool output.
- Do not use `sendMessageDraft` in MVP. It is promising for streaming, but it is ephemeral and the final response still needs `sendMessage`.

### Discord retained path

Discord should remain supported, but the default should change from "thread per session" to "control channel plus explicit bindings".

Default Discord model:

- One private control channel or DM.
- Slash commands first.
- Plain text replies only if message content intent is enabled and the message is in an explicitly bound surface.
- Session threads are optional, created only on explicit command or when binding an existing thread.
- Forum post intake can be kept later as an optional feature, not as the baseline bridge model.

Discord output rules:

- Always use `allowed_mentions: { parse: [] }`.
- Keep transcript-style assistant and reasoning text.
- Keep compact tool lines.
- Keep reactions for routine lifecycle where the surface supports them.
- Avoid repeated session metadata embeds.
- Treat Discord rate limits as normal backpressure and persist retryable work before sleeping.

## OpenCode event mapping

The bridge should ignore noisy or unsafe raw events and relay a small set of durable user-facing events.

| OpenCode event | Bridge behaviour |
| --- | --- |
| `session.created` | Update session cache. Do not post unless the session is bound or was created from a platform. |
| `session.updated` | Update cache. Optionally rename platform surface if the adapter supports it. Do not post a repeated metadata message. |
| `message.part.updated` | Relay assistant text and reasoning parts for bound sessions. Buffer and coalesce short bursts. |
| `message.part.delta` | Ignore for outbound transcript unless later proven necessary. It lacks enough stable part-type context for clean transcript routing. |
| `permission.asked` | Post a clear permission request with request ID and response commands. |
| `permission.replied` | Mark the platform permission message as resolved where possible. |
| `session.idle` / `session.status` | Mark with reactions or low-key status updates. Avoid chat spam. |
| tool result parts | Suppress routine read/search/list success. Relay important or failed tools as compact lines. |
| `session.error` | Relay a concise error to every bound surface. |

## Scheduled prompt automation

Scheduled prompts are deliberately simple in the first implementation:

- Jobs are created only by allowlisted Telegram or Discord users.
- A job targets the OpenCode session that was active in the chat or channel at creation time.
- The schedule syntax is `every <duration> <prompt>`, where duration supports minutes, hours, or days.
- The bridge accepts intervals from `5m` to `7d`.
- Due jobs are checked every 30 seconds in the continuous bridge commands.
- `automation-once` runs due jobs once, which is useful for debugging or a separate cron-style setup.
- Missed intervals do not catch up in a burst after downtime. The next run is calculated from the time the bridge processes the job.
- The runner records `lastRunAt`, `lastError`, and `nextRunAt` in the JSON state file.

This keeps automation deterministic and reviewable without inventing a separate job queue. If schedules need cron syntax,
per-job model choices, or conditional execution later, those should be added as explicit state fields rather than hidden
prompt conventions.

## Session resolution rules

Inbound text should resolve in this order:

1. Explicit session ID in the command.
2. Existing binding for the exact platform surface, for example Telegram `chat_id + message_thread_id`.
3. The platform-specific active session for that user/chat, if configured.
4. Latest OpenCode session only for explicit `attach latest`.
5. Create a session only for explicit `/oc new` or a configured auto-create mode.

This avoids the bridge guessing and accidentally sending a prompt to the wrong repo or session.

## Failure model

| Failure | Behaviour |
| --- | --- |
| OpenCode server unavailable | Keep platform adapters alive, respond with a clear health error, retry health checks with backoff. |
| Telegram polling fails | Keep last committed offset, back off, retry. Do not advance offset until the update has been processed or safely rejected. |
| Discord Gateway disconnects | Resume when possible using persisted session ID, resume URL, and sequence. Re-identify only when resume is not valid. |
| Platform send is rate-limited | Persist retryable delivery, sleep for platform-provided retry time where available, retry with a bounded policy. |
| Bridge process restarts | Reload state, recheck OpenCode health, resubscribe to events, list sessions, backfill recent messages for bound sessions if needed. |
| Permission request arrives while platform offline | Persist pending permission in state or recover with OpenCode permission list on reconnect. |
| Duplicate platform update | Detect by Telegram update offset or Discord message ID plus platform surface. Ignore if already processed. |

## Package location options

There are three reasonable places to build this.

### Option A: `llmfiles/apps/opencode-messaging-bridge/`

Pros:

- Keeps the bridge next to the OpenCode config and current plugin prototype.
- Keeps it in the source-of-truth repo for LLM tooling.
- Easy to symlink/install through the existing `justfile` pattern.
- Avoids mixing personal runtime code into Atlas.

Cons:

- `llmfiles` currently has no root Node workspace, so the app needs its own package boundaries.
- Deployment/service files need to be documented carefully so the repo does not become a hidden runtime state store.

### Option B: new dedicated repo

Pros:

- Clean daemon lifecycle and dependencies.
- Easier to package and run as a service later.
- No risk of bloating `llmfiles`.

Cons:

- More setup before the first working bridge.
- Current Discord plugin prototype and docs would live in a separate repo from the replacement.

### Option C: `lifeos-scrubbed/tools/` or Atlas runtime

Pros:

- Existing TypeScript/Yarn tooling is already present.
- Atlas already has dashboard/server conventions if this later gets a UI.

Cons:

- This bridge is OpenCode tooling, not Atlas domain logic.
- It would couple a personal agent-control daemon to the Atlas runtime repo.
- It risks creating another source of truth away from `llmfiles`.

Current judgement: start with Option A. It is the smallest reversible step and keeps the bridge close to the config it controls. If it grows into a general public daemon, move it to a dedicated repo later.

## Phased implementation plan

### Phase 1: daemon skeleton and OpenCode adapter

Acceptance criteria:

- `apps/opencode-messaging-bridge/` has a small TypeScript package.
- Config loads from environment variables only.
- State file can be read, validated, written atomically, and created if missing.
- OpenCode health check works against an explicit base URL.
- OpenCode session list and session create work from a local CLI command.
- No Telegram or Discord token is required yet.

Verification:

- Typecheck passes.
- Unit tests cover config parsing and state migration/defaulting.
- Manual command can list OpenCode sessions from a running `opencode serve`.

### Phase 2: Telegram inbound and outbound MVP

Current status: Telegram long polling, allowlist checks, command responses, session binding, session creation, prompt
sends, abort commands, permission replies, assistant text relay from OpenCode server-sent events, optional managed
`opencode serve`, and a Docker runtime are implemented in `apps/opencode-messaging-bridge/`. The remaining Phase 2 gaps
are live smoke testing and polishing output fidelity.

Acceptance criteria:

- Telegram long polling persists `updateOffset`.
- Allowlisted Telegram user/chat checks reject unauthorised messages.
- `/oc status`, `/oc sessions`, `/oc attach`, `/oc new`, and `/oc prompt` work.
- Assistant output for the bound session is sent back to Telegram.
- Telegram messages are chunked safely below 4096 characters.

Verification:

- Smoke test with mocked Telegram API and mocked OpenCode adapter.
- Manual private Telegram chat test with a non-secret local env file.
- Docker smoke test with mounted OpenCode auth/config and a private Telegram chat.

### Phase 3: OpenCode event fidelity and permission flow

Acceptance criteria:

- `message.part.updated` text/reasoning output is coalesced and relayed in order.
- Routine tool events are suppressed.
- Important/failed tool events are compacted.
- Permission requests are shown with request IDs and response commands.
- `/oc allow`, `/oc always`, and `/oc deny` call the current permission reply endpoint.
- Restarting the daemon does not lose bindings or Telegram offset.

Verification:

- Mock OpenCode SSE stream covers text, reasoning, tool, permission, status, and error events.
- Manual prompt that asks for a permission round-trip can be completed from Telegram.

### Phase 4: Discord adapter without thread dependency

Current status: Discord Gateway ownership, REST responses, allowlisted control-channel routing, slash commands, optional
prefix commands, Gateway resume metadata, session binding, prompt sends, aborts, permission replies, and assistant text
relay are implemented in `apps/opencode-messaging-bridge/`. The remaining gaps are optional explicit thread binding and
live smoke testing against the real Discord bot runtime.

Acceptance criteria:

- Discord Gateway connection is owned by the daemon, not the OpenCode plugin.
- Slash commands work in the configured control channel or DM.
- Discord allowlist is enforced.
- Outbound Discord messages use `allowed_mentions: { parse: [] }`.
- Session binding works without creating a thread.
- Optional explicit thread binding works for existing threads.
- Discord rate-limited sends are retried through the daemon, not lost with an OpenCode worker exit.

Verification:

- Existing Discord smoke harness is ported to the daemon interfaces.
- Manual Discord control-channel test covers attach, new, prompt, output, and permission reply.

### Phase 5: migration from plugin state

Acceptance criteria:

- Existing plugin state can be imported from `$HOME/.local/state/opencode/discord-remote-control/state.json`.
- Imported Discord session/thread mappings become daemon bindings.
- The import is dry-run by default and writes only when explicitly requested.
- The old plugin remains available as reference until parity is verified.

Verification:

- Dry-run import prints the mappings that would be created.
- Import does not copy tokens or runtime heartbeats.
- Manual check confirms recovered sessions still map to expected Discord surfaces.

## Next steps

Phase 1, Telegram control, Discord control, managed process supervision, event relay, permission replies, scheduled prompt
automation, and Docker Compose packaging now live in `llmfiles/apps/opencode-messaging-bridge/`. The next implementation
step is to smoke test the real runtimes and decide the voice path:

- smoke test the continuous `discord` command against the private Discord control channel, once with an external
  `opencode serve` and once through Docker Compose with `OPENCODE_BRIDGE_COMMAND=discord`
- smoke test the continuous `telegram` command against a private Telegram chat, once with an external `opencode serve`
  and once with `OPENCODE_BRIDGE_MANAGE_OPENCODE=1`
- build and run the Docker image with mounted `~/.local/share/opencode`, mounted `~/.config/opencode`, a
  project workdir mount, and a private bridge env file
- decide whether reasoning parts should be sent by default or gated behind a config flag
- smoke test `/oc schedule`, `/oc jobs`, `/oc run-now`, and `/oc unschedule` from Telegram and Discord
- choose an opt-in voice transcription hook without storing provider secrets in bridge state

The dedicated-repo option can stay deferred until the daemon has Telegram and Discord parity. Keeping the first implementation in `llmfiles` is still the smallest reversible step.
