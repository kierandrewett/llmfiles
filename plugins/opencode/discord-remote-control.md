# Discord remote-control plugin

File: `~/.config/opencode/plugins/discord-remote-control.ts`

This plugin lets a dedicated Discord channel remote-control opencode sessions.

It is disabled unless both a bot token and channel ID are configured. Inbound control is disabled unless an allowlist of Discord user IDs is configured.
Prefix commands still work as a fallback, but the plugin can also register a Discord slash command and route each opencode session into its own Discord thread.

## Required Discord setup

- Create a Discord application and bot.
- Invite the bot to the server/channel with permission to read messages and send messages.
- Include the `applications.commands` scope in the invite if you want slash commands.
- Enable the Message Content privileged intent in the Discord Developer Portal if you want prefix commands and plain-text replies from guild channels.
- Give the bot `Create Public Threads` if `OPENCODE_DISCORD_SESSION_THREADS=1` and `OPENCODE_DISCORD_THREAD_TYPE=public`.
- Give the bot `Create Private Threads` if `OPENCODE_DISCORD_THREAD_TYPE=private`.
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
export OPENCODE_DISCORD_INCLUDE_TOOL_OUTPUT="1"
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
export OPENCODE_DISCORD_STATE_PATH="$HOME/.local/state/opencode/discord-remote-control/state.json"
```

Slash commands default to `/oc`. If `OPENCODE_DISCORD_APPLICATION_ID` is not set, the plugin tries to read the application ID from the Discord Gateway `READY` payload before registering the command. Set `OPENCODE_DISCORD_GUILD_ID` during setup if you want Discord to update the command immediately inside one server rather than waiting for global command propagation.

Session threads are opt-in because they create visible Discord threads. Set `OPENCODE_DISCORD_SESSION_THREADS=1` to route session-specific assistant output, tool events, permission requests, and plain replies into a per-session thread. The configured channel remains the control channel and fallback target.

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
- No tokens or channel IDs are stored in the file.
- The state file stores only slash-command registration signatures and session-to-thread IDs. It does not store the bot token.
- Reasoning relay means OpenCode `reasoning` parts exposed through its event stream, not hidden model internals.

## Sources checked

- OpenCode plugins: https://opencode.ai/docs/plugins/
- OpenCode config/plugin loading: https://opencode.ai/docs/config/#plugins
- Discord Gateway lifecycle and intents: https://discord.com/developers/docs/topics/gateway
- Discord create message API: https://discord.com/developers/docs/resources/channel#create-message
- Discord message content intent: https://discord.com/developers/docs/resources/message#message-object
- Discord application commands: https://discord.com/developers/docs/interactions/application-commands
- Discord interaction responses: https://discord.com/developers/docs/interactions/receiving-and-responding
- Discord Gateway `INTERACTION_CREATE`: https://discord.com/developers/docs/topics/gateway-events#interaction-create
- Discord start thread without message: https://discord.com/developers/docs/resources/channel#start-thread-without-message
