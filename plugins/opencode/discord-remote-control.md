# Discord remote-control plugin

File: `~/.config/opencode/plugins/discord-remote-control.ts`

This plugin lets a dedicated Discord channel remote-control opencode sessions.

It is disabled unless both a bot token and channel ID are configured. Inbound control is disabled unless an allowlist of Discord user IDs is configured.
Prefix commands still work as a fallback, but the plugin can also register a Discord slash command, route each opencode session into its own Discord thread, render relayed events as Discord embeds, update the bot presence with the number of connected opencode sessions, and turn new forum posts into fresh opencode sessions.

## Required Discord setup

- Create a Discord application and bot.
- Invite the bot to the server/channel with permission to read messages and send messages.
- Include the `applications.commands` scope in the invite if you want slash commands.
- Enable the Message Content privileged intent in the Discord Developer Portal if you want prefix commands and plain-text replies from guild channels.
- Give the bot `Create Public Threads` if `OPENCODE_DISCORD_SESSION_THREADS=1` and `OPENCODE_DISCORD_THREAD_TYPE=public`.
- Give the bot `Create Private Threads` if `OPENCODE_DISCORD_THREAD_TYPE=private`.
- Give the bot `Manage Threads` if you want it to rename user-created forum posts from opencode session metadata and apply tags to existing forum threads.
- Give the bot `Manage Channels` if you want it to create missing forum/media tags automatically.
- Use a dedicated private channel or thread for this bridge.

## Environment

Set these before starting opencode:

```bash
export OPENCODE_DISCORD_BOT_TOKEN="your-bot-token"
export OPENCODE_DISCORD_CHANNEL_ID="discord-channel-or-thread-id"
export OPENCODE_DISCORD_ALLOWED_USER_IDS="your-discord-user-id"
```

Optional controls:

```bash
export OPENCODE_DISCORD_PREFIX="!oc"
export OPENCODE_DISCORD_IMPLICIT_REPLY="1"
export OPENCODE_DISCORD_AUTO_ATTACH="1"
export OPENCODE_DISCORD_AUTO_CREATE_SESSION="1"
export OPENCODE_DISCORD_INCLUDE_REASONING="1"
export OPENCODE_DISCORD_INCLUDE_TOOL_OUTPUT="0"
export OPENCODE_DISCORD_SESSION_ID="optional-session-id"
export OPENCODE_DISCORD_AGENT="optional-agent-name"
export OPENCODE_DISCORD_APPLICATION_ID="optional-application-id"
export OPENCODE_DISCORD_GUILD_ID="optional-guild-id-for-fast-slash-command-updates"
export OPENCODE_DISCORD_SLASH_COMMAND="oc"
export OPENCODE_DISCORD_SLASH_COMMANDS="1"
export OPENCODE_DISCORD_REGISTER_SLASH_COMMANDS="1"
export OPENCODE_DISCORD_SLASH_EPHEMERAL="1"
export OPENCODE_DISCORD_SESSION_THREADS="0"
export OPENCODE_DISCORD_THREAD_TYPE="public"
export OPENCODE_DISCORD_THREAD_AUTO_ARCHIVE_MINUTES="1440"
export OPENCODE_DISCORD_THREAD_NAME_PREFIX="opencode"
export OPENCODE_DISCORD_FORUM_POSTS="1"
export OPENCODE_DISCORD_FORUM_TAGS="1"
export OPENCODE_DISCORD_PRESENCE="1"
export OPENCODE_DISCORD_PRESENCE_UPDATE_MS="30000"
export OPENCODE_DISCORD_RUNTIME_TTL_MS="90000"
export OPENCODE_DISCORD_STATE_PATH="$HOME/.local/state/opencode/discord-remote-control/state.json"
```

Slash commands default to `/oc`. If `OPENCODE_DISCORD_APPLICATION_ID` is not set, the plugin tries to read the application ID from the Discord Gateway `READY` payload before registering the command. Set `OPENCODE_DISCORD_GUILD_ID` during setup if you want Discord to update the command immediately inside one server rather than waiting for global command propagation.

## Behaviour

### Session threads

Session threads are opt-in because they create visible Discord threads. Set `OPENCODE_DISCORD_SESSION_THREADS=1` to route session-specific assistant output, transcript-style thinking/tool summaries, permission requests, and plain replies into a per-session thread.

- Routine lifecycle events such as step start/finish, idle, status, and todo updates are best-effort reactions on the latest session message rather than standalone embeds.
- Prompt acknowledgements use a reaction on the source message where possible, or the slash-command ephemeral acknowledgement.
- The configured channel remains the control channel and fallback target when it can receive normal messages.
- Thread names are based on opencode session metadata: title, folder, branch, and short session ID.
- The first metadata embed in the thread shows folder, branch, and model/variant.
- Later session metadata changes rename/tag the thread silently instead of posting repeated `Session updated` embeds.
- If the configured channel is a Discord forum/media channel, the bridge creates the thread with the starter `message` object required by Discord before posting the richer metadata embed inside the new thread.
- If Discord rate-limits thread creation, the bridge waits for Discord's `Retry-After` header or `retry_after` field and retries instead of immediately falling back to the forum/media parent, because those parent channels cannot receive normal messages.

### Forum posts

Forum posts are enabled by default with `OPENCODE_DISCORD_FORUM_POSTS=1`. If the configured channel is a Discord forum/media channel, a new post from an allowed user is treated as a request to start a fresh opencode session.

The bridge creates a short-lived classifier session titled `Discord forum intake classifier`, ignores it in relay/session selection, lets it inspect local files with read-only tools (`read`, `grep`, `glob`, `list`), and asks it to return strict JSON for the target directory, title, provider/model, variant, and cleaned prompt. It then creates the real session in that directory, binds it to the forum thread, renames the thread from session metadata where Discord permissions allow it, applies forum tags where possible, posts the metadata embed, and sends the cleaned prompt to the real session.

### Forum tags

Forum tags are enabled by default with `OPENCODE_DISCORD_FORUM_TAGS=1`. The bridge reuses or creates tags for the model, model plus variant, and folder plus branch, then applies up to Discord's five-tag thread limit.

Discord caps forum tag names at 20 characters, so long paths such as `~/dev/lifeos-scrubbed:master` are compacted deterministically before tag creation. The full folder and branch still appear in the metadata embed. If the forum already has 20 available tags, or Discord permissions are missing, the bridge logs a warning and continues without blocking the session.

### Tool reporting

Tool reporting is deliberately quiet. Successful `read`, `grep`, `glob`, `list`, `skill`, and `todowrite` calls are suppressed. Successful important tools such as `bash`, `edit`, `write`, `apply_patch`, `task`, and `webfetch` get one low-key transcript line, for example `-> bash: Tests passed`.

Failed tools get a compact transcript entry with the short input summary, output snippet, and call ID. Tool arguments and output are not dumped by default. Set `OPENCODE_DISCORD_INCLUDE_TOOL_OUTPUT=1` if you want snippets included in important successful tool summaries.

Text and reasoning transcript output is relayed from typed `message.part.updated` events rather than raw delta events, because raw deltas do not include enough part-type information to distinguish assistant text from reasoning consistently.

### Presence and coordination

Presence is enabled by default. Each running plugin instance writes a short-lived heartbeat into the state file, and the bot presence is updated to show the number of connected opencode sessions. The state file is also used to choose a single local coordinator for control-channel commands, so multiple opencode processes do not all answer the same Discord command.

## Commands

Slash commands:

- `/oc help` - show command help.
- `/oc status` - show active session, thread mode, bot ID, pending permissions, and opencode status.
- `/oc sessions` - list recent sessions.
- `/oc attach [session_id]` - attach `latest` or a specific session.
- `/oc new [title]` - create and attach a new session.
- `/oc prompt <text>` or `/oc reply <text>` - send text to the selected session.
- `/oc abort` - abort the selected session.
- `/oc allow [id]`, `/oc always [id]`, `/oc deny [id]` - answer pending permission requests.

Prefix commands:

- `!oc help` - show command help.
- `!oc status` - show active session, bot ID, pending permissions, and opencode status.
- `!oc sessions` - list recent sessions.
- `!oc attach latest` - attach the newest non-ignored session.
- `!oc attach <session-id>` - attach a specific session.
- `!oc new [title]` - create and attach a new session.
- `!oc prompt <text>` or `!oc reply <text>` - send text to the active session.
- `!oc abort` - abort the active session.
- `!oc allow <id>`, `!oc always <id>`, `!oc deny <id>` - answer pending permission requests.

If `OPENCODE_DISCORD_IMPLICIT_REPLY=1`, any plain message from an allowed user is treated as a reply to the active session.

When session threads are enabled, plain messages inside a known session thread reply to that thread's opencode session rather than the global active session.

## Safety model

- The bridge ignores every Discord user not listed in `OPENCODE_DISCORD_ALLOWED_USER_IDS`.
- Outbound Discord messages use `allowed_mentions: { parse: [] }`, so relayed tool output cannot ping people, roles, `@here`, or `@everyone`.
- Slash command interaction responses also use `allowed_mentions: { parse: [] }` and default to ephemeral acknowledgements.
- The plugin ignores the local auto-commit helper session title by default: `Generate git commit message`.
- The plugin also ignores the forum intake classifier session title: `Discord forum intake classifier`.
- The forum intake classifier is read-only. It can inspect files with `read`, `grep`, `glob`, and `list`, but cannot write files, run shell commands, spawn tasks, or call web/skill tools.
- No tokens or channel IDs are stored in the file.
- The state file stores only slash-command registration signatures, session-to-thread IDs, and local runtime heartbeats. It does not store the bot token.
- Reasoning relay means OpenCode `reasoning` parts exposed through its event stream, not hidden model internals.

## Sources checked

- OpenCode plugins: https://opencode.ai/docs/plugins/
- OpenCode config/plugin loading: https://opencode.ai/docs/config/#plugins
- Discord Gateway lifecycle and intents: https://discord.com/developers/docs/topics/gateway
- Discord create message API: https://discord.com/developers/docs/resources/channel#create-message
- Discord embed object and limits: https://discord.com/developers/docs/resources/message#embed-object
- Discord message content intent: https://discord.com/developers/docs/resources/message#message-object
- Discord message thread field for thread starter/forum posts: https://discord.com/developers/docs/resources/message#message-object-message-structure
- Discord forum/media channel types: https://discord.com/developers/docs/resources/channel#channel-object-channel-types
- Discord application commands: https://discord.com/developers/docs/interactions/application-commands
- Discord interaction responses: https://discord.com/developers/docs/interactions/receiving-and-responding
- Discord Gateway `INTERACTION_CREATE`: https://discord.com/developers/docs/topics/gateway-events#interaction-create
- Discord Gateway update presence: https://discord.com/developers/docs/topics/gateway-events#update-presence
- Discord start thread without message: https://discord.com/developers/docs/resources/channel#start-thread-without-message
- Discord start thread in forum/media channel: https://discord.com/developers/docs/resources/channel#start-thread-in-forum-or-media-channel
- Discord forum tags and `available_tags`: https://discord.com/developers/docs/resources/channel#forum-tag-object
- Discord modify channel/thread `available_tags` and `applied_tags`: https://discord.com/developers/docs/resources/channel#modify-channel
- Discord create reaction: https://discord.com/developers/docs/resources/channel#create-reaction
- Discord rate limits and retry-after handling: https://discord.com/developers/docs/topics/rate-limits
