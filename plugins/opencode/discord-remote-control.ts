import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN = "discord-remote-control";
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY_VERSION = "10";
const DEFAULT_PREFIX = "!oc";
const DEFAULT_SLASH_COMMAND = "oc";
const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const DEFAULT_IGNORED_SESSION_TITLE_RE = /Generate git commit message|Discord forum intake classifier/i;
const DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES = 1440;
const DEFAULT_RUNTIME_TTL_MS = 90000;
const DEFAULT_PRESENCE_UPDATE_MS = 30000;
const DISCORD_RATE_LIMIT_MAX_RETRIES = 2;
const DISCORD_RATE_LIMIT_MAX_WAIT_MS = 120000;
const DISCORD_FORUM_TAG_LIMIT = 20;
const DISCORD_FORUM_AVAILABLE_TAG_LIMIT = 20;
const DISCORD_THREAD_APPLIED_TAG_LIMIT = 5;
const CLASSIFIER_SESSION_TITLE = "Discord forum intake classifier";
const INTAKE_CLASSIFIER_TOOLS: Record<string, boolean> = {
    bash: false,
    edit: false,
    write: false,
    apply_patch: false,
    read: true,
    grep: true,
    glob: true,
    list: true,
    task: false,
    todowrite: false,
    webfetch: false,
    skill: false,
};
const DISCORD_EPHEMERAL_FLAG = 1 << 6;
const DISCORD_CHAT_INPUT_COMMAND = 1;
const DISCORD_OPTION_SUBCOMMAND = 1;
const DISCORD_OPTION_STRING = 3;
const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_PONG = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_INTERACTION_CHANNEL_MESSAGE = 4;
const DISCORD_PUBLIC_THREAD = 11;
const DISCORD_PRIVATE_THREAD = 12;
const DISCORD_GUILD_FORUM = 15;
const DISCORD_GUILD_MEDIA = 16;
const FATAL_GATEWAY_CLOSE_CODES = new Map([
    [4004, "authentication failed; check OPENCODE_DISCORD_BOT_TOKEN"],
    [4010, "invalid shard"],
    [4013, "invalid intents"],
    [4014, "disallowed intents; enable the Message Content intent or reduce requested intents"],
]);
const EMBED_COLOR = {
    assistant: 0x5865f2,
    thinking: 0x9b59b6,
    tool: 0x3498db,
    success: 0x2ecc71,
    warning: 0xf1c40f,
    error: 0xe74c3c,
    info: 0x95a5a6,
};
const ICON = {
    assistant: "\u{1F916}",
    thinking: "\u{1F9E0}",
    tool: "\u{1F527}",
    success: "\u{2705}",
    warning: "\u{26A0}\u{FE0F}",
    error: "\u{274C}",
    info: "\u{2139}\u{FE0F}",
    idle: "\u{1F4A4}",
    patch: "\u{1F4DD}",
    agent: "\u{1F9D1}\u{200D}\u{1F4BB}",
    permission: "\u{1F510}",
    todo: "\u{1F4CB}",
};
const REACTION = {
    step: "\u{1F501}",
    done: "\u{2705}",
    idle: "\u{1F4A4}",
    status: "\u{2139}\u{FE0F}",
    tool: "\u{1F527}",
    failed: "\u{274C}",
    todo: "\u{1F4CB}",
};
const IMPORTANT_TOOL_NAMES = new Set([
    "apply_patch",
    "bash",
    "edit",
    "task",
    "webfetch",
    "write",
]);

type JsonObject = Record<string, unknown>;

type LogLevel = "debug" | "info" | "warn" | "error";
type PermissionReply = "once" | "always" | "reject";
type ThreadType = "public" | "private";

type ModelMetadata = {
    providerID: string;
    modelID: string;
    variant: string | null;
};

type SessionMetadata = {
    id: string;
    title: string | null;
    directory: string | null;
    branch: string | null;
    model: ModelMetadata | null;
};

type ForumThreadState = {
    threadID: string;
    name: string | null;
    ownerID: string | null;
    createdAt: number;
};

type ForumIntakePlan = {
    title: string;
    directory: string | null;
    model: ModelMetadata | null;
    prompt: string;
};

type PluginContext = {
    client: unknown;
    directory: string;
};

type PluginEventInput = {
    event: unknown;
};

type ChatMessageHookInput = {
    sessionID?: string | null;
    model?: unknown;
    variant?: unknown;
};

type ToolExecuteHookInput = {
    sessionID?: string | null;
    callID?: string | null;
    tool?: string | null;
    args?: unknown;
};

type SessionMethod = (input?: unknown) => Promise<unknown>;

type OpenCodeClientLike = {
    app?: {
        log?: (input: { body: { service: string; level: LogLevel; message: string; extra?: JsonObject } }) => Promise<unknown>;
    };
    tui?: {
        showToast?: (input: { body: { title: string; message: string; variant?: string; duration?: number } }) => Promise<unknown>;
    };
    session?: {
        abort?: SessionMethod;
        create?: SessionMethod;
        delete?: SessionMethod;
        get?: SessionMethod;
        list?: SessionMethod;
        prompt?: SessionMethod;
        promptAsync?: SessionMethod;
        status?: SessionMethod;
    };
    permission?: {
        reply?: SessionMethod;
    };
    vcs?: {
        get?: SessionMethod;
    };
    postSessionIdPermissionsPermissionId?: SessionMethod;
};

type Config = {
    enabled: boolean;
    token: string;
    channelID: string;
    applicationID: string | null;
    guildID: string | null;
    allowedUserIDs: Set<string>;
    prefix: string;
    slashCommand: string;
    slashCommandsEnabled: boolean;
    registerSlashCommands: boolean;
    slashResponsesEphemeral: boolean;
    implicitReply: boolean;
    autoAttachLatest: boolean;
    autoCreateSession: boolean;
    includeReasoning: boolean;
    includeToolOutput: boolean;
    threadsEnabled: boolean;
    threadType: ThreadType;
    threadAutoArchiveMinutes: number;
    threadNamePrefix: string;
    forumPostsEnabled: boolean;
    forumTagsEnabled: boolean;
    statePath: string;
    initialSessionID: string | null;
    agent: string | null;
    maxMessageChars: number;
    maxToolOutputChars: number;
    streamFlushMs: number;
    sendDelayMs: number;
    reconnectBaseMs: number;
    reconnectMaxMs: number;
    runtimeTtlMs: number;
    presenceUpdateMs: number;
    presenceEnabled: boolean;
    ignoredSessionTitleRe: RegExp;
};

type DiscordGatewayPayload = {
    op: number;
    d?: unknown;
    s?: number | null;
    t?: string | null;
};

type DiscordUser = {
    id?: string;
    bot?: boolean;
    username?: string;
};

type DiscordMessage = {
    id?: string | undefined;
    channel_id?: string | undefined;
    guild_id?: string | undefined;
    content?: string | undefined;
    author?: DiscordUser | undefined;
    thread?: DiscordChannel | undefined;
};

type DiscordChannel = {
    id?: string;
    type?: number;
    name?: string;
    parent_id?: string | null;
    owner_id?: string | null;
    application_id?: string | null;
    available_tags?: DiscordForumTag[];
    applied_tags?: string[];
};

type DiscordForumTag = {
    id?: string;
    name: string;
    moderated?: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
};

type SessionMessageReference = {
    channelID: string;
    messageID: string;
};

type DiscordInteractionOption = {
    name?: string;
    type?: number;
    value?: string | number | boolean;
    options?: DiscordInteractionOption[];
};

type DiscordInteraction = {
    id?: string;
    application_id?: string;
    token?: string;
    type?: number;
    channel_id?: string;
    guild_id?: string;
    user?: DiscordUser;
    member?: {
        user?: DiscordUser;
    };
    data?: {
        name?: string;
        type?: number;
        options?: DiscordInteractionOption[];
    };
};

type CommandContext = {
    sourceChannelID?: string | null;
    sourceMessageID?: string | null;
    sourceSessionID?: string | null;
    silentAck?: boolean;
};

type DiscordTarget = {
    channelID?: string | null | undefined;
    sessionID?: string | null | undefined;
};

type DiscordEmbed = {
    title?: string;
    description?: string;
    color?: number;
    timestamp?: string;
    fields?: Array<{
        name: string;
        value: string;
        inline?: boolean;
    }>;
    footer?: {
        text: string;
    };
};

type DiscordOutboundMessage = {
    content?: string;
    embeds?: DiscordEmbed[];
};

type RuntimeState = {
    instanceID: string;
    pid: number;
    directory: string;
    activeSessionID: string | null;
    startedAt: number;
    updatedAt: number;
};

type PersistentState = {
    version: 1;
    registrations: Record<string, string>;
    threads: Record<string, Record<string, string>>;
    runtimes: Record<string, RuntimeState>;
};

type PendingPermission = {
    requestID: string;
    sessionID: string | null;
    title: string;
    patterns: string[];
};

type ParsedCommand =
    | { kind: "command"; command: string; rest: string }
    | { kind: "implicit"; command: "reply"; rest: string };

type StreamBuffer = {
    sessionID: string;
    partID: string;
    kind: "assistant" | "thinking";
    text: string;
    timer: ReturnType<typeof setTimeout> | null;
};

type TextPartProgress = {
    length: number;
};

function asObject(value: unknown): JsonObject | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

function boolValue(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return fallback;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number(String(value || ""));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function defaultStatePath(): string {
    const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(stateRoot, "opencode", PLUGIN, "state.json");
}

function slashCommandName(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
    return normalized || DEFAULT_SLASH_COMMAND;
}

function threadTypeValue(value: string): ThreadType {
    return value.trim().toLowerCase() === "private" ? "private" : "public";
}

function threadTypeCode(value: ThreadType): number {
    return value === "private" ? DISCORD_PRIVATE_THREAD : DISCORD_PUBLIC_THREAD;
}

function normalizeThreadArchiveMinutes(value: number): number {
    const allowed = [60, 1440, 4320, 10080];
    return allowed.includes(value) ? value : DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES;
}

function safeThreadNamePart(value: string | null | undefined, fallback = "unknown"): string {
    return (value || fallback)
        .replace(/[^a-zA-Z0-9._ -]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 72);
}

function safeThreadName(prefix: string, sessionID: string, metadata: SessionMetadata | null | undefined): string {
    const title = safeThreadNamePart(metadata?.title, "untitled");
    const folder = metadata?.directory ? safeThreadNamePart(basename(metadata.directory), "") : "";
    const branch = metadata?.branch ? safeThreadNamePart(metadata.branch, "") : "";
    const context = [folder, branch].filter(Boolean).join(" ");
    const label = [title, context].filter(Boolean).join(" - ");
    const suffix = ` ${shortSessionID(sessionID)}`;
    const head = `${prefix} ${label || "session"}`
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, Math.max(1, 100 - suffix.length))
        .trim();
    return `${head}${suffix}`.replace(/\s+/g, " ").trim().slice(0, 100) || `${prefix} ${shortSessionID(sessionID)}`.slice(0, 100);
}

function optionString(options: JsonObject, key: string, envNames: string[], fallback = ""): string {
    const configured = stringValue(options[key]);
    if (configured !== null) return configured;
    for (const envName of envNames) {
        const value = stringValue(process.env[envName]);
        if (value !== null) return value;
    }
    return fallback;
}

function optionBool(options: JsonObject, key: string, envNames: string[], fallback: boolean): boolean {
    if (key in options) return boolValue(options[key], fallback);
    for (const envName of envNames) {
        if (process.env[envName] !== undefined) return boolValue(process.env[envName], fallback);
    }
    return fallback;
}

function optionNumber(options: JsonObject, key: string, envNames: string[], fallback: number, min: number, max: number): number {
    if (key in options) return numberValue(options[key], fallback, min, max);
    for (const envName of envNames) {
        if (process.env[envName] !== undefined) return numberValue(process.env[envName], fallback, min, max);
    }
    return fallback;
}

function csvSet(value: string): Set<string> {
    return new Set(
        value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
    );
}

function parseConfig(options?: Record<string, unknown>): Config {
    const pluginOptions = asObject(options) || {};
    const token = optionString(pluginOptions, "token", ["OPENCODE_DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
    const channelID = optionString(pluginOptions, "channelID", ["OPENCODE_DISCORD_CHANNEL_ID", "DISCORD_CHANNEL_ID"]);
    const applicationID = optionString(pluginOptions, "applicationID", ["OPENCODE_DISCORD_APPLICATION_ID", "DISCORD_APPLICATION_ID"]);
    const guildID = optionString(pluginOptions, "guildID", ["OPENCODE_DISCORD_GUILD_ID", "DISCORD_GUILD_ID"]);
    const allowedUsers = optionString(pluginOptions, "allowedUserIDs", ["OPENCODE_DISCORD_ALLOWED_USER_IDS"]);
    const ignoredTitlePattern = optionString(pluginOptions, "ignoredSessionTitlePattern", ["OPENCODE_DISCORD_IGNORED_SESSION_TITLE_RE"]);

    let ignoredSessionTitleRe = DEFAULT_IGNORED_SESSION_TITLE_RE;
    if (ignoredTitlePattern) {
        try {
            ignoredSessionTitleRe = new RegExp(ignoredTitlePattern, "i");
        } catch {
            ignoredSessionTitleRe = DEFAULT_IGNORED_SESSION_TITLE_RE;
        }
    }

    return {
        enabled: optionBool(pluginOptions, "enabled", ["OPENCODE_DISCORD_ENABLED"], true) && Boolean(token && channelID),
        token,
        channelID,
        applicationID: applicationID || null,
        guildID: guildID || null,
        allowedUserIDs: csvSet(allowedUsers),
        prefix: optionString(pluginOptions, "prefix", ["OPENCODE_DISCORD_PREFIX"], DEFAULT_PREFIX),
        slashCommand: slashCommandName(optionString(pluginOptions, "slashCommand", ["OPENCODE_DISCORD_SLASH_COMMAND"], DEFAULT_SLASH_COMMAND)),
        slashCommandsEnabled: optionBool(pluginOptions, "slashCommandsEnabled", ["OPENCODE_DISCORD_SLASH_COMMANDS"], true),
        registerSlashCommands: optionBool(pluginOptions, "registerSlashCommands", ["OPENCODE_DISCORD_REGISTER_SLASH_COMMANDS"], true),
        slashResponsesEphemeral: optionBool(pluginOptions, "slashResponsesEphemeral", ["OPENCODE_DISCORD_SLASH_EPHEMERAL"], true),
        implicitReply: optionBool(pluginOptions, "implicitReply", ["OPENCODE_DISCORD_IMPLICIT_REPLY"], true),
        autoAttachLatest: optionBool(pluginOptions, "autoAttachLatest", ["OPENCODE_DISCORD_AUTO_ATTACH"], true),
        autoCreateSession: optionBool(pluginOptions, "autoCreateSession", ["OPENCODE_DISCORD_AUTO_CREATE_SESSION"], true),
        includeReasoning: optionBool(pluginOptions, "includeReasoning", ["OPENCODE_DISCORD_INCLUDE_REASONING"], true),
        includeToolOutput: optionBool(pluginOptions, "includeToolOutput", ["OPENCODE_DISCORD_INCLUDE_TOOL_OUTPUT"], false),
        threadsEnabled: optionBool(pluginOptions, "threadsEnabled", ["OPENCODE_DISCORD_SESSION_THREADS"], false),
        threadType: threadTypeValue(optionString(pluginOptions, "threadType", ["OPENCODE_DISCORD_THREAD_TYPE"], "public")),
        threadAutoArchiveMinutes: normalizeThreadArchiveMinutes(
            optionNumber(
                pluginOptions,
                "threadAutoArchiveMinutes",
                ["OPENCODE_DISCORD_THREAD_AUTO_ARCHIVE_MINUTES"],
                DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES,
                60,
                10080,
            ),
        ),
        threadNamePrefix: optionString(pluginOptions, "threadNamePrefix", ["OPENCODE_DISCORD_THREAD_NAME_PREFIX"], "opencode"),
        forumPostsEnabled: optionBool(pluginOptions, "forumPostsEnabled", ["OPENCODE_DISCORD_FORUM_POSTS"], true),
        forumTagsEnabled: optionBool(pluginOptions, "forumTagsEnabled", ["OPENCODE_DISCORD_FORUM_TAGS"], true),
        statePath: optionString(pluginOptions, "statePath", ["OPENCODE_DISCORD_STATE_PATH"], defaultStatePath()),
        initialSessionID: optionString(pluginOptions, "sessionID", ["OPENCODE_DISCORD_SESSION_ID"]) || null,
        agent: optionString(pluginOptions, "agent", ["OPENCODE_DISCORD_AGENT"]) || null,
        maxMessageChars: optionNumber(pluginOptions, "maxMessageChars", ["OPENCODE_DISCORD_MAX_MESSAGE_CHARS"], 1850, 500, 1990),
        maxToolOutputChars: optionNumber(pluginOptions, "maxToolOutputChars", ["OPENCODE_DISCORD_MAX_TOOL_OUTPUT_CHARS"], 1400, 200, 6000),
        streamFlushMs: optionNumber(pluginOptions, "streamFlushMs", ["OPENCODE_DISCORD_STREAM_FLUSH_MS"], 1200, 250, 10000),
        sendDelayMs: optionNumber(pluginOptions, "sendDelayMs", ["OPENCODE_DISCORD_SEND_DELAY_MS"], 750, 50, 10000),
        reconnectBaseMs: optionNumber(pluginOptions, "reconnectBaseMs", ["OPENCODE_DISCORD_RECONNECT_BASE_MS"], 1500, 250, 60000),
        reconnectMaxMs: optionNumber(pluginOptions, "reconnectMaxMs", ["OPENCODE_DISCORD_RECONNECT_MAX_MS"], 60000, 1000, 300000),
        runtimeTtlMs: optionNumber(pluginOptions, "runtimeTtlMs", ["OPENCODE_DISCORD_RUNTIME_TTL_MS"], DEFAULT_RUNTIME_TTL_MS, 10000, 600000),
        presenceUpdateMs: optionNumber(pluginOptions, "presenceUpdateMs", ["OPENCODE_DISCORD_PRESENCE_UPDATE_MS"], DEFAULT_PRESENCE_UPDATE_MS, 5000, 300000),
        presenceEnabled: optionBool(pluginOptions, "presenceEnabled", ["OPENCODE_DISCORD_PRESENCE"], true),
        ignoredSessionTitleRe,
    };
}

function parseDiscordRemoteCommand(content: string, prefix = DEFAULT_PREFIX, implicitReply = true): ParsedCommand | null {
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
        if (!implicitReply) return null;
        return { kind: "implicit", command: "reply", rest: trimmed };
    }

    const rest = trimmed.slice(prefix.length).trim();
    if (!rest) return { kind: "command", command: "help", rest: "" };

    const [command = "help", ...tail] = rest.split(/\s+/);
    return { kind: "command", command: command.toLowerCase(), rest: tail.join(" ").trim() };
}

function commandOption(name: string, description: string, required = false): JsonObject {
    return {
        name,
        description,
        type: DISCORD_OPTION_STRING,
        required,
    };
}

function subcommand(name: string, description: string, options: JsonObject[] = []): JsonObject {
    return {
        name,
        description,
        type: DISCORD_OPTION_SUBCOMMAND,
        options,
    };
}

function slashCommandDefinition(name: string): JsonObject {
    return {
        name,
        type: DISCORD_CHAT_INPUT_COMMAND,
        description: "Remote-control the active opencode session.",
        options: [
            subcommand("help", "Show the Discord bridge command list."),
            subcommand("status", "Show active session and pending permissions."),
            subcommand("sessions", "List recent opencode sessions."),
            subcommand("attach", "Attach a specific session, or latest if omitted.", [commandOption("session_id", "Session ID or latest.")]),
            subcommand("unlock", "Allow auto-attach to follow the latest session."),
            subcommand("new", "Create and attach a new opencode session.", [commandOption("title", "Session title.")]),
            subcommand("prompt", "Send a prompt to the session.", [commandOption("text", "Prompt text.", true)]),
            subcommand("reply", "Alias for prompt.", [commandOption("text", "Reply text.", true)]),
            subcommand("abort", "Abort the selected session."),
            subcommand("allow", "Allow a pending permission once.", [commandOption("id", "Permission request ID.")]),
            subcommand("always", "Always allow a pending permission.", [commandOption("id", "Permission request ID.")]),
            subcommand("deny", "Deny a pending permission.", [commandOption("id", "Permission request ID.")]),
        ],
    };
}

function interactionUserID(interaction: DiscordInteraction): string | null {
    return stringValue(interaction.member?.user?.id) || stringValue(interaction.user?.id);
}

function interactionOptionValue(options: DiscordInteractionOption[] | undefined, name: string): string {
    const option = (options || []).find((entry) => entry.name === name);
    if (option?.value === undefined) return "";
    return String(option.value).trim();
}

function parseSlashInteraction(interaction: DiscordInteraction, commandName: string): ParsedCommand | null {
    const data = interaction.data;
    if (!data || data.type !== DISCORD_CHAT_INPUT_COMMAND || data.name !== commandName) return null;

    const selected = (data.options || []).find((option) => option.type === DISCORD_OPTION_SUBCOMMAND);
    const command = selected?.name || "help";
    const options = selected?.options || [];

    if (command === "attach") return { kind: "command", command, rest: interactionOptionValue(options, "session_id") || "latest" };
    if (command === "new") return { kind: "command", command, rest: interactionOptionValue(options, "title") };
    if (command === "prompt" || command === "reply") return { kind: "command", command, rest: interactionOptionValue(options, "text") };
    if (["allow", "always", "deny"].includes(command)) return { kind: "command", command, rest: interactionOptionValue(options, "id") };

    return { kind: "command", command, rest: "" };
}

function splitDiscordContent(content: string, limit = 1850): string[] {
    const normalized = content.replace(/\r\n/g, "\n");
    if (normalized.length <= limit) return [normalized];

    const chunks: string[] = [];
    let remaining = normalized;
    while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf("\n", limit);
        if (splitAt < Math.floor(limit * 0.5)) splitAt = remaining.lastIndexOf(" ", limit);
        if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
        const chunk = remaining.slice(0, splitAt).trimEnd();
        if (chunk) chunks.push(chunk);
        remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 48)).trimEnd()}\n\n[truncated ${text.length - limit} chars]`;
}

function jsonPreview(value: unknown, limit: number): string {
    if (value === undefined) return "";
    try {
        return truncate(JSON.stringify(value, null, 2), limit);
    } catch {
        return truncate(String(value), limit);
    }
}

function stripSystemReminders(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

function fenced(language: string, content: string): string {
    const safe = content.replace(/```/g, "` ` `");
    return `\`\`\`${language}\n${safe}\n\`\`\``;
}

function embedText(text: string, limit = 4000): string {
    return truncate(text.trim() || "No details.", limit);
}

function embedField(name: string, value: string, inline = true): { name: string; value: string; inline?: boolean } {
    return {
        name: truncate(name || "Field", 256),
        value: truncate(value || "none", 1024),
        inline,
    };
}

function sessionFooter(sessionID: string | null | undefined): { text: string } {
    return { text: `opencode session ${shortSessionID(sessionID)}` };
}

function makeEmbed(input: {
    title: string;
    description?: string | undefined;
    color?: number | undefined;
    fields?: Array<{ name: string; value: string; inline?: boolean }> | undefined;
    sessionID?: string | null | undefined;
}): DiscordEmbed {
    const embed: DiscordEmbed = {
        title: truncate(input.title, 256),
        color: input.color || EMBED_COLOR.info,
        timestamp: new Date().toISOString(),
    };
    if (input.description) embed.description = embedText(input.description);
    if (input.fields?.length) embed.fields = input.fields.slice(0, 25).map((field) => embedField(field.name, field.value, field.inline));
    if (input.sessionID !== undefined) embed.footer = sessionFooter(input.sessionID);
    return embed;
}

function textMessage(content: string): DiscordOutboundMessage {
    return { content };
}

function discordQuote(text: string, limit = 1500): string {
    const cleaned = truncate(stripSystemReminders(text), limit);
    return cleaned
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
}

function transcriptLine(label: string, detail?: string | null): string {
    const cleanDetail = detail ? stripSystemReminders(detail) : "";
    return cleanDetail ? `-> ${label}: ${truncate(cleanDetail, 220)}` : `-> ${label}`;
}

function transcriptStreamMessage(kind: "assistant" | "thinking", text: string): DiscordOutboundMessage {
    const cleaned = stripSystemReminders(text);
    if (kind === "assistant") return textMessage(cleaned);

    const [first = "working", ...rest] = cleaned.split("\n");
    const title = first.trim() || "working";
    const body = rest.join("\n").trim();
    return textMessage(body ? `*Thinking: ${truncate(title, 160)}*\n${discordQuote(body)}` : `*Thinking: ${truncate(title, 160)}*`);
}

function embedMessage(embed: DiscordEmbed): DiscordOutboundMessage {
    return { embeds: [embed] };
}

function shortSessionID(sessionID: string | null | undefined): string {
    if (!sessionID) return "none";
    return sessionID.length <= 12 ? sessionID : sessionID.slice(0, 12);
}

function unwrapData(value: unknown): unknown {
    const object = asObject(value);
    if (object && "data" in object) return object.data;
    return value;
}

function extractSessionID(value: unknown): string | null {
    const data = asObject(unwrapData(value));
    if (!data) return null;
    return stringValue(data.id) || stringValue(data.sessionID);
}

function sessionIDFromEvent(event: JsonObject): string | null {
    const properties = asObject(event.properties) || {};
    const direct = stringValue(properties.sessionID) || stringValue(properties.sessionId);
    if (direct) return direct;

    const info = asObject(properties.info);
    const infoID = stringValue(info?.id) || stringValue(info?.sessionID) || stringValue(info?.sessionId);
    if (infoID) return infoID;

    const part = asObject(properties.part);
    const partID = stringValue(part?.sessionID) || stringValue(part?.sessionId);
    if (partID) return partID;

    return null;
}

function titleFromEvent(event: JsonObject): string | null {
    const properties = asObject(event.properties) || {};
    const info = asObject(properties.info);
    return stringValue(info?.title);
}

function sessionObjectFromValue(value: unknown): JsonObject | null {
    const data = asObject(unwrapData(value));
    if (!data) return null;
    return asObject(data.info) || data;
}

function sessionIDFromObject(object: JsonObject | null | undefined): string | null {
    if (!object) return null;
    return stringValue(object.id) || stringValue(object.sessionID) || stringValue(object.sessionId);
}

function modelFromValue(value: unknown, variantValue?: unknown): ModelMetadata | null {
    const object = asObject(value);
    if (!object) return null;
    const providerID = stringValue(object.providerID) || stringValue(object.providerId) || stringValue(object.provider);
    const modelID = stringValue(object.modelID) || stringValue(object.modelId) || stringValue(object.model);
    if (!providerID || !modelID) return null;
    return {
        providerID,
        modelID,
        variant: stringValue(variantValue) || stringValue(object.variant),
    };
}

function modelFromMessage(message: JsonObject): ModelMetadata | null {
    const direct = modelFromValue(message.model, message.variant);
    if (direct) return direct;

    const providerID = stringValue(message.providerID) || stringValue(message.providerId) || stringValue(message.provider);
    const modelID = stringValue(message.modelID) || stringValue(message.modelId) || stringValue(message.model);
    if (!providerID || !modelID) return null;
    return {
        providerID,
        modelID,
        variant: stringValue(message.variant),
    };
}

function formatDirectory(value: string | null | undefined): string {
    if (!value) return "unknown";
    const home = homedir();
    if (value === home) return "~";
    if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
    return value;
}

function inlineCode(value: string | null | undefined): string {
    return `\`${truncate((value || "unknown").replace(/`/g, "'"), 1000)}\``;
}

function modelLabel(model: ModelMetadata | null | undefined): string {
    if (!model) return "unknown";
    const base = `${model.providerID}/${model.modelID}`;
    return model.variant ? `${base} (${model.variant})` : base;
}

function modelTagLabel(model: ModelMetadata | null | undefined, includeVariant: boolean): string | null {
    if (!model) return null;
    const base = `${model.providerID}/${model.modelID}`;
    if (!includeVariant || !model.variant) return base;
    return `${base} ${model.variant}`;
}

function compactForumTagName(value: string): string {
    const cleaned = value
        .replace(/[`\n\r\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return "unknown";
    if (cleaned.length <= DISCORD_FORUM_TAG_LIMIT) return cleaned;

    const suffixIndex = cleaned.lastIndexOf(":");
    if (suffixIndex > 0) {
        const suffix = cleaned.slice(suffixIndex);
        const headLimit = DISCORD_FORUM_TAG_LIMIT - suffix.length - 3;
        if (headLimit >= 4) return `${cleaned.slice(0, headLimit)}...${suffix}`;
    }

    return `${cleaned.slice(0, DISCORD_FORUM_TAG_LIMIT - 3)}...`;
}

function sessionForumTagNames(metadata: SessionMetadata): string[] {
    const candidates = [
        modelTagLabel(metadata.model, false),
        modelTagLabel(metadata.model, true),
        metadata.directory && metadata.branch ? `${formatDirectory(metadata.directory)}:${metadata.branch}` : null,
    ];
    const names = new Set<string>();
    for (const candidate of candidates) {
        if (!candidate) continue;
        const name = compactForumTagName(candidate);
        if (name) names.add(name);
    }
    return [...names].slice(0, DISCORD_THREAD_APPLIED_TAG_LIMIT);
}

function metadataSignature(metadata: SessionMetadata): string {
    return [metadata.title || "", metadata.directory || "", metadata.branch || "", modelLabel(metadata.model)].join("\n");
}

function discordRequiresForumStarterMessage(error: unknown): boolean {
    const text = String(error);
    return text.includes("Invalid Form Body") && text.includes('"message"') && text.includes("BASE_TYPE_REQUIRED");
}

function discordCannotSendToChannel(error: unknown): boolean {
    const text = String(error);
    return text.includes('"code": 50008') || text.includes("Cannot send messages in a non-text channel");
}

function numericSeconds(value: string | null): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function retryAfterSecondsFromBody(body: string): number | null {
    try {
        const parsed = asObject(JSON.parse(body));
        const value = parsed?.retry_after;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
        return numericSeconds(typeof value === "string" ? value : null);
    } catch {
        return null;
    }
}

function discordRateLimitRetryAfterMs(response: Response, body: string): number | null {
    const seconds =
        numericSeconds(response.headers.get("Retry-After")) ??
        numericSeconds(response.headers.get("X-RateLimit-Reset-After")) ??
        retryAfterSecondsFromBody(body);
    if (seconds === null) return null;
    return Math.max(0, Math.ceil(seconds * 1000));
}

function isDiscordThreadContainerChannel(channel: JsonObject | null): boolean {
    if (!channel) return false;
    const type = typeof channel.type === "number" ? channel.type : Number(channel.type);
    return type === DISCORD_GUILD_FORUM || type === DISCORD_GUILD_MEDIA || Array.isArray(channel.available_tags);
}

function extractStructuredObject(result: unknown): JsonObject | null {
    const candidates = [
        asObject(asObject(unwrapData(result))?.info)?.structured,
        asObject(asObject(unwrapData(result))?.info)?.structured_output,
        asObject(asObject(unwrapData(result))?.info)?.structuredOutput,
        asObject(unwrapData(result))?.structured,
        asObject(unwrapData(result))?.structured_output,
        asObject(unwrapData(result))?.structuredOutput,
        asObject(result)?.structured,
        asObject(result)?.structured_output,
        asObject(result)?.structuredOutput,
    ];

    for (const candidate of candidates) {
        const object = asObject(candidate);
        if (object) return object;
    }

    const parts = asArray(asObject(unwrapData(result))?.parts || asObject(result)?.parts);
    const text = parts
        .map((part) => {
            const object = asObject(part) || {};
            return stringValue(object.text) || stringValue(object.content) || "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    if (!text) return null;

    try {
        return asObject(JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "")));
    } catch {
        return null;
    }
}

function normaliseForumIntakePlan(raw: JsonObject | null, fallbackTitle: string, fallbackPrompt: string, baseDirectory: string): ForumIntakePlan {
    const directory = normaliseDirectory(stringValue(raw?.directory), baseDirectory);
    const rawModel = asObject(raw?.model);
    const providerID = stringValue(raw?.providerID) || stringValue(raw?.providerId) || stringValue(rawModel?.providerID) || stringValue(rawModel?.providerId);
    const modelID = stringValue(raw?.modelID) || stringValue(raw?.modelId) || stringValue(rawModel?.modelID) || stringValue(rawModel?.modelId);
    return {
        title: truncate(stringValue(raw?.title) || fallbackTitle || "Discord forum session", 120),
        directory,
        model: providerID && modelID ? { providerID, modelID, variant: stringValue(raw?.variant) } : null,
        prompt: stringValue(raw?.prompt) || fallbackPrompt,
    };
}

function normaliseDirectory(value: string | null | undefined, baseDirectory = directoryFromProcess()): string | null {
    if (!value) return null;
    let candidate = value.trim();
    if (!candidate || candidate.includes("\0")) return null;
    if (candidate.startsWith("file://")) {
        try {
            candidate = new URL(candidate).pathname;
        } catch {
            return null;
        }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null;
    return isAbsolute(candidate) ? resolve(candidate) : resolve(baseDirectory, candidate);
}

function directoryFromProcess(): string {
    try {
        return process.cwd();
    } catch {
        return homedir();
    }
}

function textPartProgressKey(sessionID: string, partID: string, kind: "assistant" | "thinking"): string {
    return `${sessionID}:${partID}:${kind}`;
}

function getPartDelta(sessionID: string, partID: string, kind: "assistant" | "thinking", part: JsonObject, properties: JsonObject, progress: Map<string, TextPartProgress>): string {
    const explicitDelta = stringValue(properties.delta);
    if (explicitDelta !== null) {
        const currentText = stringValue(part.text) || "";
        progress.set(textPartProgressKey(sessionID, partID, kind), { length: currentText.length });
        return explicitDelta;
    }

    const text = stringValue(part.text) || "";
    const key = textPartProgressKey(sessionID, partID, kind);
    const previous = progress.get(key)?.length || 0;
    progress.set(key, { length: text.length });
    if (text.length <= previous) return "";
    return text.slice(previous);
}

function normaliseToolName(tool: string): string {
    const parts = tool.toLowerCase().split(/[.:/]+/).filter(Boolean);
    return parts[parts.length - 1] || tool.toLowerCase();
}

function isImportantTool(tool: string): boolean {
    return IMPORTANT_TOOL_NAMES.has(normaliseToolName(tool));
}

function compactToolArgs(tool: string, args: unknown): string | null {
    const object = asObject(args);
    if (!object) return null;
    const keys = normaliseToolName(tool) === "bash"
        ? ["description", "command", "workdir"]
        : ["description", "filePath", "path", "pattern", "include", "url", "target", "command"];
    const rows = keys
        .map((key) => {
            const value = stringValue(object[key]);
            return value ? `${key}: ${truncate(value, 180)}` : null;
        })
        .filter((row): row is string => Boolean(row));
    return rows.length ? rows.join("\n") : null;
}

function numberFromUnknown(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function toolOutputFailed(output: JsonObject): boolean {
    if (output.error || output.errors || output.exception) return true;
    const metadata = asObject(output.metadata) || {};
    const status = [output.status, output.state, metadata.status, metadata.state, output.title]
        .map((entry) => stringValue(entry) || "")
        .join(" ");
    if (/\b(error|failed|failure|denied|timeout|cancelled)\b/i.test(status)) return true;
    const exitCode = numberFromUnknown(output.exitCode) ?? numberFromUnknown(output.exit_code) ?? numberFromUnknown(metadata.exitCode) ?? numberFromUnknown(metadata.exit_code);
    return exitCode !== null && exitCode !== 0;
}

function toolOutputPreview(output: JsonObject, maxChars: number): string {
    return stringValue(output.error) || stringValue(output.output) || jsonPreview(output.metadata, maxChars) || "";
}

function formatToolResultMessage(
    tool: string,
    callID: string,
    args: unknown,
    output: JsonObject,
    maxChars: number,
    includeOutput: boolean,
    failed: boolean,
): DiscordOutboundMessage {
    const title = stringValue(output.title) || (failed ? "failed" : "done");
    const argsSummary = compactToolArgs(tool, args);
    const preview = failed || includeOutput ? toolOutputPreview(output, maxChars) : "";
    const lines = [transcriptLine(failed ? `${tool} failed` : tool, title)];
    if (failed && argsSummary) lines.push(discordQuote(argsSummary, 500));
    if (preview) lines.push(fenced("text", truncate(preview, Math.min(maxChars, failed ? 900 : 500))));
    if (failed) lines.push(`call: \`${callID || "unknown"}\``);
    return textMessage(lines.join("\n"));
}

function formatPermissionEmbed(permission: PendingPermission, prefix = DEFAULT_PREFIX, slashCommand = DEFAULT_SLASH_COMMAND): DiscordEmbed {
    const patterns = permission.patterns.length ? permission.patterns.join(", ") : "no patterns";
    return makeEmbed({
        title: `${ICON.permission} Permission requested`,
        description: permission.title,
        color: EMBED_COLOR.warning,
        fields: [
            { name: "Request", value: `\`${permission.requestID}\`` },
            { name: "Patterns", value: truncate(patterns, 1024), inline: false },
            {
                name: "Reply",
                value: `\`${prefix} allow ${permission.requestID}\`, \`${prefix} always ${permission.requestID}\`, \`${prefix} deny ${permission.requestID}\`, or \`/${slashCommand} allow id:${permission.requestID}\``,
                inline: false,
            },
        ],
        sessionID: permission.sessionID,
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DiscordRemoteControl: Plugin = async ({ client, directory }: PluginContext, options?: Record<string, unknown>) => {
    const config = parseConfig(options);
    const opencode = client as OpenCodeClientLike;
    const pendingPermissions = new Map<string, PendingPermission>();
    const ignoredSessions = new Set<string>();
    const textProgress = new Map<string, TextPartProgress>();
    const streamBuffers = new Map<string, StreamBuffer>();
    const seenToolStates = new Set<string>();
    const sessionTitles = new Map<string, string>();
    const sessionMetadata = new Map<string, SessionMetadata>();
    const announcedMetadataSignatures = new Map<string, string>();
    const syncedMetadataSignatures = new Map<string, string>();
    const sessionThreads = new Map<string, string>();
    const threadSessions = new Map<string, string>();
    const threadCreatePromises = new Map<string, Promise<string | null>>();
    const threadFailures = new Set<string>();
    const threadNames = new Map<string, string>();
    const lastSessionMessages = new Map<string, SessionMessageReference>();
    const forumTagCache = new Map<string, DiscordForumTag>();
    const forumThreads = new Map<string, ForumThreadState>();
    const forumIntakes = new Set<string>();
    const controlFallbackWarnings = new Set<string>();
    const instanceID = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const instanceStartedAt = Date.now();
    let persistentState: PersistentState = { version: 1, registrations: {}, threads: {}, runtimes: {} };
    let applicationID = config.applicationID;
    let activeSessionID = config.initialSessionID;
    let activeSessionLocked = Boolean(config.initialSessionID);
    let botUserID: string | null = null;
    let sendQueue: Promise<void> = Promise.resolve();
    let websocket: WebSocket | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatStartTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSequence: number | null = null;
    let gatewaySessionID: string | null = null;
    let resumeGatewayURL: string | null = null;
    let reconnectAttempts = 0;
    let heartbeatAcked = true;
    let gatewayStopped = false;
    let presenceTimer: ReturnType<typeof setInterval> | null = null;
    let currentBranch: string | null = null;
    let configuredChannelHasForumTags: boolean | null = null;
    let controlChannelCanReceiveMessages: boolean | null = null;

    async function log(level: LogLevel, message: string, extra: JsonObject = {}): Promise<void> {
        try {
            await opencode.app?.log?.({ body: { service: PLUGIN, level, message, extra } });
        } catch {
            // Discord control must not break opencode lifecycle.
        }
    }

    async function toast(title: string, message: string, variant = "info"): Promise<void> {
        try {
            await opencode.tui?.showToast?.({ body: { title, message, variant, duration: 8000 } });
        } catch {
            // TUI feedback is best-effort; Discord/log output carries the state.
        }
    }

    function metadataForSession(sessionID: string): SessionMetadata {
        const existing = sessionMetadata.get(sessionID);
        if (existing) return existing;
        const metadata: SessionMetadata = {
            id: sessionID,
            title: sessionTitles.get(sessionID) || null,
            directory,
            branch: currentBranch,
            model: null,
        };
        sessionMetadata.set(sessionID, metadata);
        return metadata;
    }

    function rememberSessionMetadata(sessionID: string, updates: Partial<Omit<SessionMetadata, "id">>): SessionMetadata {
        const next: SessionMetadata = {
            ...metadataForSession(sessionID),
            ...updates,
            id: sessionID,
        };
        sessionMetadata.set(sessionID, next);
        if (next.title) sessionTitles.set(sessionID, next.title);
        return next;
    }

    function rememberSessionObject(object: JsonObject | null | undefined, fallbackSessionID?: string | null): SessionMetadata | null {
        const sessionID = sessionIDFromObject(object) || fallbackSessionID || null;
        if (!sessionID) return null;
        const existing = metadataForSession(sessionID);
        const targetDirectory = stringValue(object?.directory) || existing.directory || directory;
        return rememberSessionMetadata(sessionID, {
            title: stringValue(object?.title) || existing.title,
            directory: targetDirectory,
            branch: existing.branch || (targetDirectory === directory ? currentBranch : null),
        });
    }

    function rememberModelMetadata(sessionID: string, model: ModelMetadata | null): SessionMetadata {
        if (!model) return metadataForSession(sessionID);
        return rememberSessionMetadata(sessionID, { model });
    }

    function sessionMetadataFields(metadata: SessionMetadata): Array<{ name: string; value: string; inline?: boolean }> {
        return [
            { name: "Title", value: metadata.title || "untitled", inline: false },
            { name: "Folder", value: inlineCode(formatDirectory(metadata.directory)), inline: false },
            { name: "Branch", value: inlineCode(metadata.branch || "unknown") },
            { name: "Model/variant", value: inlineCode(modelLabel(metadata.model)), inline: false },
        ];
    }

    function sessionMetadataEmbed(sessionID: string, title: string): DiscordEmbed {
        const metadata = metadataForSession(sessionID);
        return makeEmbed({
            title,
            color: EMBED_COLOR.info,
            fields: sessionMetadataFields(metadata),
            sessionID,
        });
    }

    function legacySessionPath(sessionID: string): JsonObject {
        return { id: sessionID, sessionID };
    }

    async function callSessionCreate(title: string, targetDirectory = directory): Promise<unknown> {
        if (!opencode.session?.create) return null;
        try {
            return await opencode.session.create({ title, directory: targetDirectory });
        } catch (error) {
            await log("debug", "Session create with flat shape failed; retrying legacy shape", { title, targetDirectory, error: String(error) });
            return await opencode.session.create({ body: { title }, query: { directory: targetDirectory } });
        }
    }

    async function callSessionList(targetDirectory = directory): Promise<unknown> {
        if (!opencode.session?.list) return null;
        try {
            return await opencode.session.list({ directory: targetDirectory });
        } catch (error) {
            await log("debug", "Session list with flat shape failed; retrying legacy shape", { targetDirectory, error: String(error) });
            return await opencode.session.list({ query: { directory: targetDirectory } });
        }
    }

    async function callSessionStatus(targetDirectory = directory): Promise<unknown> {
        if (!opencode.session?.status) return null;
        try {
            return await opencode.session.status({ directory: targetDirectory });
        } catch (error) {
            await log("debug", "Session status with flat shape failed; retrying legacy shape", { targetDirectory, error: String(error) });
            return await opencode.session.status({ query: { directory: targetDirectory } });
        }
    }

    async function callSessionGet(sessionID: string, targetDirectory = directory): Promise<unknown> {
        if (!opencode.session?.get) return null;
        try {
            return await opencode.session.get({ sessionID, directory: targetDirectory });
        } catch (error) {
            await log("debug", "Session get with flat shape failed; retrying legacy shape", { sessionID, targetDirectory, error: String(error) });
            return await opencode.session.get({ path: legacySessionPath(sessionID), query: { directory: targetDirectory } });
        }
    }

    async function callSessionAbort(sessionID: string, targetDirectory = directory): Promise<unknown> {
        if (!opencode.session?.abort) return null;
        try {
            return await opencode.session.abort({ sessionID, directory: targetDirectory });
        } catch (error) {
            await log("debug", "Session abort with flat shape failed; retrying legacy shape", { sessionID, targetDirectory, error: String(error) });
            return await opencode.session.abort({ path: legacySessionPath(sessionID), query: { directory: targetDirectory } });
        }
    }

    async function callSessionDelete(sessionID: string, targetDirectory = directory): Promise<unknown> {
        if (!opencode.session?.delete) return null;
        try {
            return await opencode.session.delete({ sessionID, directory: targetDirectory });
        } catch (error) {
            await log("debug", "Session delete with flat shape failed; retrying legacy shape", { sessionID, targetDirectory, error: String(error) });
            return await opencode.session.delete({ path: legacySessionPath(sessionID), query: { directory: targetDirectory } });
        }
    }

    async function callSessionPrompt(method: "prompt" | "promptAsync", sessionID: string, targetDirectory: string, body: JsonObject): Promise<unknown> {
        const sessionApi = opencode.session;
        const fn = sessionApi?.[method];
        if (!fn) return null;
        try {
            return await fn.call(sessionApi, { sessionID, directory: targetDirectory, ...body });
        } catch (error) {
            await log("debug", `Session ${method} with flat shape failed; retrying legacy shape`, { sessionID, targetDirectory, error: String(error) });
            return await fn.call(sessionApi, { path: legacySessionPath(sessionID), body, query: { directory: targetDirectory } });
        }
    }

    async function refreshBranch(targetDirectory = directory): Promise<string | null> {
        if (!opencode.vcs?.get) return currentBranch;
        try {
            const result = await opencode.vcs.get({ directory: targetDirectory });
            const branch = stringValue(asObject(unwrapData(result))?.branch);
            if (branch && targetDirectory === directory) currentBranch = branch;
            if (branch) return branch;
        } catch (error) {
            try {
                const result = await opencode.vcs.get({ query: { directory: targetDirectory } });
                const branch = stringValue(asObject(unwrapData(result))?.branch);
                if (branch && targetDirectory === directory) currentBranch = branch;
                if (branch) return branch;
            } catch (fallbackError) {
                await log("debug", "Failed to refresh branch from OpenCode VCS API", {
                    error: String(error),
                    fallbackError: String(fallbackError),
                });
            }
        }
        return targetDirectory === directory ? currentBranch : null;
    }

    async function ensureSessionMetadata(sessionID: string): Promise<SessionMetadata> {
        const knownDirectory = metadataForSession(sessionID).directory || directory;
        const branch = await refreshBranch(knownDirectory);
        try {
            const result = await callSessionGet(sessionID, knownDirectory);
            rememberSessionObject(sessionObjectFromValue(result), sessionID);
        } catch (error) {
            await log("debug", "Failed to refresh session metadata from OpenCode", { sessionID, error: String(error) });
        }
        const metadata = metadataForSession(sessionID);
        if (branch && !metadata.branch) return rememberSessionMetadata(sessionID, { branch });
        return metadata;
    }

    function threadStateKey(): string {
        return `${config.channelID}:${config.threadType}`;
    }

    function registrationStateKey(id: string): string {
        return `${id}:${config.guildID || "global"}:${config.slashCommand}`;
    }

    function hydrateThreadState(): void {
        sessionThreads.clear();
        threadSessions.clear();
        const threads = persistentState.threads[threadStateKey()] || {};
        for (const [sessionID, threadID] of Object.entries(threads)) {
            if (!sessionID || !threadID) continue;
            sessionThreads.set(sessionID, threadID);
            threadSessions.set(threadID, sessionID);
        }
    }

    function normalisePersistentState(parsed: JsonObject | null): PersistentState {
        const registrations = asObject(parsed?.registrations) || {};
        const threads = asObject(parsed?.threads) || {};
        const runtimes = asObject(parsed?.runtimes) || {};

        return {
            version: 1,
            registrations: Object.fromEntries(Object.entries(registrations).map(([key, value]) => [key, String(value)])),
            threads: Object.fromEntries(
                Object.entries(threads).map(([key, value]) => {
                    const mapping = asObject(value) || {};
                    return [key, Object.fromEntries(Object.entries(mapping).map(([sessionID, threadID]) => [sessionID, String(threadID)]))];
                }),
            ),
            runtimes: Object.fromEntries(
                Object.entries(runtimes)
                    .map(([key, value]) => {
                        const runtime = asObject(value);
                        if (!runtime) return null;
                        const updatedAt = numberValue(runtime.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER);
                        const startedAt = numberValue(runtime.startedAt, updatedAt, 0, Number.MAX_SAFE_INTEGER);
                        const pid = numberValue(runtime.pid, 0, 0, Number.MAX_SAFE_INTEGER);
                        if (!updatedAt || !pid) return null;
                        return [
                            key,
                            {
                                instanceID: stringValue(runtime.instanceID) || key,
                                pid,
                                directory: stringValue(runtime.directory) || "unknown",
                                activeSessionID: stringValue(runtime.activeSessionID),
                                startedAt,
                                updatedAt,
                            } satisfies RuntimeState,
                        ] as const;
                    })
                    .filter((entry): entry is readonly [string, RuntimeState] => Boolean(entry)),
            ),
        };
    }

    async function readPersistentStateFromDisk(): Promise<PersistentState> {
        const raw = await readFile(config.statePath, "utf8");
        return normalisePersistentState(asObject(JSON.parse(raw)));
    }

    function pruneRuntimeState(now = Date.now()): void {
        persistentState.runtimes = Object.fromEntries(
            Object.entries(persistentState.runtimes).filter(([, runtime]) => now - runtime.updatedAt <= config.runtimeTtlMs),
        );
    }

    async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
        const lockPath = `${config.statePath}.lock`;
        await mkdir(dirname(config.statePath), { recursive: true });

        for (let attempt = 0; attempt < 20; attempt += 1) {
            let handle: Awaited<ReturnType<typeof open>> | null = null;
            try {
                handle = await open(lockPath, "wx");
                await handle.writeFile(`${process.pid}\n`, "utf8");
                return await fn();
            } catch (error) {
                const code = asObject(error)?.code;
                if (code !== "EEXIST") throw error;

                try {
                    const info = await stat(lockPath);
                    if (Date.now() - info.mtimeMs > 10000) await rm(lockPath, { force: true });
                } catch {
                    // Another process may have removed the lock between open and stat.
                }
                await sleep(50 + attempt * 25);
            } finally {
                if (handle) {
                    await handle.close().catch(() => undefined);
                    await rm(lockPath, { force: true }).catch(() => undefined);
                }
            }
        }

        throw new Error(`Timed out waiting for Discord plugin state lock: ${lockPath}`);
    }

    async function loadPersistentState(): Promise<void> {
        try {
            persistentState = await readPersistentStateFromDisk();
            pruneRuntimeState();
            hydrateThreadState();
        } catch (error) {
            const code = asObject(error)?.code;
            if (code !== "ENOENT") await log("warn", "Failed to load Discord plugin state; starting with empty state", { error: String(error) });
            persistentState = { version: 1, registrations: {}, threads: {}, runtimes: {} };
        }
    }

    async function savePersistentState(): Promise<void> {
        try {
            await mkdir(dirname(config.statePath), { recursive: true });
            await writeFile(config.statePath, `${JSON.stringify(persistentState, null, 2)}\n`, "utf8");
        } catch (error) {
            await log("warn", "Failed to save Discord plugin state", { error: String(error) });
        }
    }

    async function mutatePersistentState(mutator: (state: PersistentState) => void): Promise<void> {
        await withStateLock(async () => {
            try {
                persistentState = await readPersistentStateFromDisk();
            } catch (error) {
                const code = asObject(error)?.code;
                if (code !== "ENOENT") throw error;
                persistentState = { version: 1, registrations: {}, threads: {}, runtimes: {} };
            }
            pruneRuntimeState();
            mutator(persistentState);
            await savePersistentState();
            hydrateThreadState();
        });
    }

    async function persistThreadMapping(sessionID: string, threadID: string): Promise<void> {
        await mutatePersistentState((state) => {
            const key = threadStateKey();
            state.threads[key] = {
                ...(state.threads[key] || {}),
                [sessionID]: threadID,
            };
        });
    }

    async function bindSessionThread(sessionID: string, threadID: string, name?: string | null): Promise<void> {
        sessionThreads.set(sessionID, threadID);
        threadSessions.set(threadID, sessionID);
        if (name) threadNames.set(threadID, name);
        await persistThreadMapping(sessionID, threadID);
    }

    function runtimeEntries(): RuntimeState[] {
        pruneRuntimeState();
        return Object.values(persistentState.runtimes).sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
    }

    function coordinatorRuntime(): RuntimeState | null {
        return runtimeEntries()[0] || null;
    }

    function connectedSessionCount(): number {
        const sessionIDs = new Set(
            runtimeEntries()
                .map((runtime) => runtime.activeSessionID)
                .filter((sessionID): sessionID is string => Boolean(sessionID)),
        );
        return sessionIDs.size || runtimeEntries().length;
    }

    function localOwnsSession(sessionID: string | null | undefined): boolean {
        return Boolean(sessionID && activeSessionID === sessionID);
    }

    async function markRuntimeState(updatePresence = true): Promise<void> {
        await mutatePersistentState((state) => {
            state.runtimes[instanceID] = {
                instanceID,
                pid: process.pid,
                directory,
                activeSessionID,
                startedAt: instanceStartedAt,
                updatedAt: Date.now(),
            };
        });

        if (updatePresence) sendPresence();
    }

    async function removeRuntimeState(): Promise<void> {
        await mutatePersistentState((state) => {
            delete state.runtimes[instanceID];
        });
        sendPresence();
    }

    async function isCoordinatorRuntime(): Promise<boolean> {
        await loadPersistentState();
        return coordinatorRuntime()?.instanceID === instanceID;
    }

    async function discordFetch(route: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
        const response = await fetch(`${DISCORD_API}${route}`, {
            ...init,
            headers: {
                Authorization: `Bot ${config.token}`,
                "Content-Type": "application/json",
                ...(init.headers || {}),
            },
        });

        if (response.status === 204) return null;

        const text = await response.text();
        if (response.status === 429 && attempt < DISCORD_RATE_LIMIT_MAX_RETRIES) {
            const retryAfterMs = discordRateLimitRetryAfterMs(response, text);
            if (retryAfterMs !== null && retryAfterMs <= DISCORD_RATE_LIMIT_MAX_WAIT_MS) {
                await log("warn", "Discord rate limit hit; retrying request", {
                    route,
                    retryAfterMs,
                    attempt: attempt + 1,
                });
                await sleep(retryAfterMs);
                return await discordFetch(route, init, attempt + 1);
            }
        }

        if (!response.ok) {
            throw new Error(`Discord API ${response.status}: ${truncate(text, 500)}`);
        }
        if (!text) return null;
        return JSON.parse(text) as unknown;
    }

    async function discordWebhookFetch(route: string, init: RequestInit = {}): Promise<unknown> {
        const response = await fetch(`${DISCORD_API}${route}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...(init.headers || {}),
            },
        });

        if (response.status === 204) return null;

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Discord webhook ${response.status}: ${truncate(text, 500)}`);
        }
        if (!text) return null;
        return JSON.parse(text) as unknown;
    }

    async function renameDiscordThread(threadID: string, name: string): Promise<void> {
        if (threadNames.get(threadID) === name) return;
        await discordFetch(`/channels/${threadID}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
        });
        threadNames.set(threadID, name);
    }

    async function reactToDiscordMessage(channelID: string, messageID: string, emoji: string): Promise<void> {
        await discordFetch(`/channels/${channelID}/messages/${messageID}/reactions/${encodeURIComponent(emoji)}/@me`, {
            method: "PUT",
        });
    }

    function rememberLastSessionMessage(sessionID: string | null | undefined, channelID: string, messageID: string | null): void {
        if (!sessionID || !messageID) return;
        lastSessionMessages.set(sessionID, { channelID, messageID });
    }

    function shouldRememberSessionMessage(sessionID: string | null | undefined, channelID: string): boolean {
        if (!sessionID) return false;
        if (!config.threadsEnabled) return true;
        if (channelID !== config.channelID) return true;
        return !sessionThreads.has(sessionID);
    }

    async function reactToLatestSessionMessage(sessionID: string | null | undefined, emoji: string): Promise<void> {
        if (!sessionID) return;
        const target = lastSessionMessages.get(sessionID);
        if (!target) return;
        await reactToDiscordMessage(target.channelID, target.messageID, emoji);
    }

    async function reactToCommandSource(context: CommandContext, emoji: string): Promise<boolean> {
        if (!context.sourceChannelID || !context.sourceMessageID) return false;
        await reactToDiscordMessage(context.sourceChannelID, context.sourceMessageID, emoji);
        return true;
    }

    function relayReaction(emoji: string, sessionID: string | null | undefined): void {
        void reactToLatestSessionMessage(sessionID, emoji).catch(async (error: unknown) => {
            await log("debug", "Failed to react to latest Discord session message", { sessionID: sessionID || "none", error: String(error) });
        });
    }

    function parseForumTags(value: unknown): DiscordForumTag[] {
        const tags: DiscordForumTag[] = [];
        for (const entry of asArray(value)) {
            const object = asObject(entry);
            const name = stringValue(object?.name);
            if (!name) continue;
            const tag: DiscordForumTag = { name };
            const id = stringValue(object?.id);
            if (id) tag.id = id;
            if (typeof object?.moderated === "boolean") tag.moderated = object.moderated;
            if (typeof object?.emoji_id === "string" || object?.emoji_id === null) tag.emoji_id = object.emoji_id;
            if (typeof object?.emoji_name === "string" || object?.emoji_name === null) tag.emoji_name = object.emoji_name;
            tags.push(tag);
        }
        return tags;
    }

    async function loadForumTagCache(): Promise<DiscordForumTag[]> {
        if (configuredChannelHasForumTags === false) return [];
        const channel = asObject(await discordFetch(`/channels/${config.channelID}`, { method: "GET" })) || {};
        controlChannelCanReceiveMessages = isDiscordThreadContainerChannel(channel) ? false : controlChannelCanReceiveMessages ?? true;
        if (!Array.isArray(channel.available_tags)) {
            configuredChannelHasForumTags = false;
            return [];
        }

        configuredChannelHasForumTags = true;
        const tags = parseForumTags(channel.available_tags);
        forumTagCache.clear();
        for (const tag of tags) {
            forumTagCache.set(tag.name.toLowerCase(), tag);
        }
        return tags;
    }

    async function ensureForumTagIDs(names: string[]): Promise<string[]> {
        if (!config.forumTagsEnabled || !names.length) return [];
        let tags = await loadForumTagCache();
        if (configuredChannelHasForumTags !== true) return [];

        const missing = names.filter((name) => !forumTagCache.get(name.toLowerCase()));
        if (missing.length) {
            const remainingSlots = DISCORD_FORUM_AVAILABLE_TAG_LIMIT - tags.length;
            const creatable = missing.slice(0, Math.max(0, remainingSlots));
            if (!creatable.length) {
                await log("warn", "Discord forum tag limit reached; could not create session metadata tags", { names: missing.join(", ") });
            } else {
                const updatedChannel = asObject(
                    await discordFetch(`/channels/${config.channelID}`, {
                        method: "PATCH",
                        headers: { "X-Audit-Log-Reason": "OpenCode session metadata tags" },
                        body: JSON.stringify({
                            available_tags: [...tags, ...creatable.map((name) => ({ name }))],
                        }),
                    }),
                ) || {};
                tags = parseForumTags(updatedChannel.available_tags);
                forumTagCache.clear();
                for (const tag of tags) {
                    forumTagCache.set(tag.name.toLowerCase(), tag);
                }
                if (creatable.length < missing.length) {
                    await log("warn", "Discord forum tag limit reached before all session tags were created", { names: missing.slice(creatable.length).join(", ") });
                }
            }
        }

        return names
            .map((name) => stringValue(forumTagCache.get(name.toLowerCase())?.id))
            .filter((id): id is string => Boolean(id))
            .slice(0, DISCORD_THREAD_APPLIED_TAG_LIMIT);
    }

    async function applyForumTagsToThread(sessionID: string, threadID: string): Promise<void> {
        const tagNames = sessionForumTagNames(metadataForSession(sessionID));
        const tagIDs = await ensureForumTagIDs(tagNames);
        if (!tagIDs.length) return;

        const thread = asObject(await discordFetch(`/channels/${threadID}`, { method: "GET" })) || {};
        const existing = asArray(thread.applied_tags)
            .map((entry) => String(entry))
            .filter(Boolean);
        const applied = [...new Set([...existing, ...tagIDs])].slice(0, DISCORD_THREAD_APPLIED_TAG_LIMIT);
        if (applied.length === existing.length && applied.every((tagID, index) => tagID === existing[index])) return;
        if (!tagIDs.every((tagID) => applied.includes(tagID))) {
            await log("warn", "Discord thread tag limit reached before all session tags were applied", { sessionID, threadID, tagNames: tagNames.join(", ") });
        }

        await discordFetch(`/channels/${threadID}`, {
            method: "PATCH",
            body: JSON.stringify({ applied_tags: applied }),
        });
    }

    async function registerSlashCommand(id: string): Promise<void> {
        if (!config.slashCommandsEnabled || !config.registerSlashCommands) return;

        const definition = slashCommandDefinition(config.slashCommand);
        const signature = JSON.stringify(definition);
        const stateKey = registrationStateKey(id);
        if (persistentState.registrations[stateKey] === signature) return;

        const route = config.guildID ? `/applications/${id}/guilds/${config.guildID}/commands` : `/applications/${id}/commands`;
        await discordFetch(route, {
            method: "POST",
            body: JSON.stringify(definition),
        });

        await mutatePersistentState((state) => {
            state.registrations[stateKey] = signature;
        });
        await log("info", "Registered Discord slash command", {
            command: config.slashCommand,
            scope: config.guildID ? "guild" : "global",
            guildID: config.guildID || "none",
        });
    }

    async function respondInteraction(interaction: DiscordInteraction, content: string, ephemeral = config.slashResponsesEphemeral): Promise<void> {
        if (!interaction.id || !interaction.token) return;
        const [chunk = content] = splitDiscordContent(content, config.maxMessageChars);
        await discordWebhookFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
            method: "POST",
            body: JSON.stringify({
                type: DISCORD_INTERACTION_CHANNEL_MESSAGE,
                data: {
                    content: chunk,
                    flags: ephemeral ? DISCORD_EPHEMERAL_FLAG : undefined,
                    allowed_mentions: { parse: [] },
                },
            }),
        });
    }

    async function pongInteraction(interaction: DiscordInteraction): Promise<void> {
        if (!interaction.id || !interaction.token) return;
        await discordWebhookFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
            method: "POST",
            body: JSON.stringify({ type: DISCORD_INTERACTION_PONG }),
        });
    }

    function sessionIDForDiscordChannel(channelID: string | null | undefined): string | null {
        if (!channelID || channelID === config.channelID) return null;
        return threadSessions.get(channelID) || null;
    }

    function isAllowedDiscordChannel(channelID: string | null | undefined): boolean {
        return Boolean(channelID && (channelID === config.channelID || threadSessions.has(channelID) || forumThreads.has(channelID)));
    }

    function rememberForumThread(channel: DiscordChannel | JsonObject | null | undefined): ForumThreadState | null {
        if (!config.forumPostsEnabled || !channel) return null;
        const threadID = stringValue(channel.id);
        const parentID = stringValue(channel.parent_id);
        const type = typeof channel.type === "number" ? channel.type : Number(channel.type);
        if (!threadID || parentID !== config.channelID || type !== DISCORD_PUBLIC_THREAD) return null;
        const state: ForumThreadState = {
            threadID,
            name: stringValue(channel.name),
            ownerID: stringValue(channel.owner_id),
            createdAt: Date.now(),
        };
        forumThreads.set(threadID, state);
        if (state.name) threadNames.set(threadID, state.name);
        return state;
    }

    function forumThreadForMessage(message: DiscordMessage): ForumThreadState | null {
        const fromMessage = rememberForumThread(message.thread || null);
        if (fromMessage) return fromMessage;
        const channelID = stringValue(message.channel_id);
        return channelID ? forumThreads.get(channelID) || null : null;
    }

    async function createSessionThread(sessionID: string): Promise<string | null> {
        const existing = sessionThreads.get(sessionID);
        if (existing) return existing;
        if (threadCreatePromises.has(sessionID)) return await threadCreatePromises.get(sessionID)!;

        const promise = (async () => {
            try {
                const metadata = await ensureSessionMetadata(sessionID);
                const name = safeThreadName(config.threadNamePrefix, sessionID, metadata);
                const appliedTagIDs = await ensureForumTagIDs(sessionForumTagNames(metadata)).catch(async (error: unknown) => {
                    await log("warn", "Failed to prepare Discord forum tags before thread creation", { sessionID, error: String(error) });
                    return [] as string[];
                });
                const baseBody = {
                    name,
                    auto_archive_duration: config.threadAutoArchiveMinutes,
                    type: threadTypeCode(config.threadType),
                    ...(appliedTagIDs.length ? { applied_tags: appliedTagIDs } : {}),
                };
                let result: unknown;
                try {
                    result = await discordFetch(`/channels/${config.channelID}/threads`, {
                        method: "POST",
                        body: JSON.stringify(baseBody),
                    });
                } catch (error) {
                    if (!discordRequiresForumStarterMessage(error)) throw error;
                    result = await discordFetch(`/channels/${config.channelID}/threads`, {
                        method: "POST",
                        body: JSON.stringify({
                            name,
                            auto_archive_duration: config.threadAutoArchiveMinutes,
                            ...(appliedTagIDs.length ? { applied_tags: appliedTagIDs } : {}),
                            message: {
                                content: `Starting opencode session ${shortSessionID(sessionID)}.`,
                                allowed_mentions: { parse: [] },
                            },
                        }),
                    });
                }
                const thread = asObject(result) || {};
                const threadID = stringValue(thread.id);
                if (!threadID) throw new Error("Discord thread creation response did not include an id");

                await bindSessionThread(sessionID, threadID, name);
                void announceSessionMetadata(sessionID, "Session context", threadID).catch(async (error: unknown) => {
                    await log("warn", "Failed to announce new Discord session thread metadata", { sessionID, threadID, error: String(error) });
                });
                return threadID;
            } catch (error) {
                if (!threadFailures.has(sessionID)) {
                    threadFailures.add(sessionID);
                    await log("warn", "Failed to create Discord session thread", {
                        sessionID,
                        fallback: controlChannelCanReceiveMessages === false || configuredChannelHasForumTags === true ? "disabled" : "control channel",
                        error: String(error),
                    });
                }
                return null;
            } finally {
                threadCreatePromises.delete(sessionID);
            }
        })();

        threadCreatePromises.set(sessionID, promise);
        return await promise;
    }

    async function controlChannelFallbackID(sessionID: string | null | undefined): Promise<string | null> {
        if (controlChannelCanReceiveMessages === false || configuredChannelHasForumTags === true) {
            const warningKey = sessionID || "control";
            if (!controlFallbackWarnings.has(warningKey)) {
                controlFallbackWarnings.add(warningKey);
                await log("warn", "Skipping Discord control-channel fallback because the configured channel cannot receive normal messages", {
                    sessionID: sessionID || "none",
                    channelID: config.channelID,
                });
            }
            return null;
        }
        return config.channelID;
    }

    async function targetChannelID(target: DiscordTarget): Promise<string | null> {
        if (target.channelID) return target.channelID;
        if (!config.threadsEnabled || !target.sessionID) return await controlChannelFallbackID(target.sessionID);
        const threadID = await createSessionThread(target.sessionID);
        if (threadID) return threadID;
        return await controlChannelFallbackID(target.sessionID);
    }

    function normaliseOutboundMessage(message: string | DiscordOutboundMessage): DiscordOutboundMessage {
        return typeof message === "string" ? textMessage(message) : message;
    }

    async function sendDiscordMessage(message: string | DiscordOutboundMessage, target: DiscordTarget = {}): Promise<void> {
        const outbound = normaliseOutboundMessage(message);
        const content = outbound.content || "";
        if (!content.trim() && !outbound.embeds?.length) return;

        const channelID = await targetChannelID(target);
        if (!channelID) return;
        const chunks = content.trim() ? splitDiscordContent(content, config.maxMessageChars) : [""];

        for (const [index, chunk] of chunks.entries()) {
            let result: unknown;
            try {
                result = await discordFetch(`/channels/${channelID}/messages`, {
                    method: "POST",
                    body: JSON.stringify({
                        content: chunk || undefined,
                        embeds: index === 0 ? outbound.embeds : undefined,
                        allowed_mentions: { parse: [] },
                    }),
                });
            } catch (error) {
                if (channelID === config.channelID && discordCannotSendToChannel(error)) {
                    controlChannelCanReceiveMessages = false;
                }
                throw error;
            }
            if (shouldRememberSessionMessage(target.sessionID, channelID)) {
                rememberLastSessionMessage(target.sessionID, channelID, stringValue(asObject(result)?.id));
            }
        }
    }

    function enqueueDiscordMessage(message: string | DiscordOutboundMessage, target: DiscordTarget = {}): Promise<void> {
        sendQueue = sendQueue
            .then(async () => {
                await sendDiscordMessage(message, target);
                await sleep(config.sendDelayMs);
            })
            .catch(async (error: unknown) => {
                await log("error", "Failed to send Discord message", { error: String(error) });
            });
        return sendQueue;
    }

    function relay(message: string | DiscordOutboundMessage, sessionID?: string | null): void {
        void enqueueDiscordMessage(message, { sessionID });
    }

    function replyToCommand(context: CommandContext, message: string | DiscordOutboundMessage, sessionID?: string | null): void {
        void enqueueDiscordMessage(message, { channelID: context.sourceChannelID || null, sessionID });
    }

    async function syncSessionThreadMetadata(sessionID: string, channelID?: string | null): Promise<{ metadata: SessionMetadata; threadID: string } | null> {
        const metadata = await ensureSessionMetadata(sessionID);
        const signature = metadataSignature(metadata);
        const threadID = channelID || sessionThreads.get(sessionID) || null;
        if (!threadID) return null;

        const key = `${sessionID}:${threadID}`;
        if (syncedMetadataSignatures.get(key) === signature) return { metadata, threadID };
        syncedMetadataSignatures.set(key, signature);

        const name = safeThreadName(config.threadNamePrefix, sessionID, metadata);
        await renameDiscordThread(threadID, name).catch(async (error: unknown) => {
            await log("warn", "Failed to rename Discord session thread", { sessionID, threadID, name, error: String(error) });
        });
        await applyForumTagsToThread(sessionID, threadID).catch(async (error: unknown) => {
            await log("warn", "Failed to apply Discord forum tags", { sessionID, threadID, error: String(error) });
        });

        return { metadata, threadID };
    }

    async function announceSessionMetadata(sessionID: string, title = "Session context", channelID?: string | null): Promise<void> {
        const synced = await syncSessionThreadMetadata(sessionID, channelID);
        if (!synced) return;

        const signature = metadataSignature(synced.metadata);
        if (!channelID && announcedMetadataSignatures.get(sessionID) === signature) return;
        announcedMetadataSignatures.set(sessionID, signature);

        await enqueueDiscordMessage(embedMessage(sessionMetadataEmbed(sessionID, title)), { channelID: synced.threadID, sessionID });
    }

    function isSessionIgnored(sessionID: string | null): boolean {
        return Boolean(sessionID && ignoredSessions.has(sessionID));
    }

    function shouldRelaySession(sessionID: string | null): boolean {
        if (!sessionID || isSessionIgnored(sessionID)) return false;
        if (!activeSessionID && config.autoAttachLatest) {
            activeSessionID = sessionID;
            activeSessionLocked = false;
            void markRuntimeState();
            relay(
                embedMessage(
                    makeEmbed({
                        title: "Session attached",
                        description: "Attached from the first opencode event.",
                        color: EMBED_COLOR.success,
                        sessionID,
                    }),
                ),
                sessionID,
            );
            return true;
        }
        return activeSessionID === sessionID;
    }

    async function createSession(title: string, targetDirectory = directory): Promise<string | null> {
        const result = await callSessionCreate(title, targetDirectory);
        const sessionID = extractSessionID(result);
        if (sessionID) {
            activeSessionID = sessionID;
            activeSessionLocked = true;
            const branch = await refreshBranch(targetDirectory);
            rememberSessionMetadata(sessionID, {
                title,
                directory: targetDirectory,
                branch,
            });
            void markRuntimeState();
        }
        return sessionID;
    }

    async function latestSessionID(): Promise<string | null> {
        const result = await callSessionList(directory);
        const data = unwrapData(result);
        const sessions = asArray(data);
        for (const session of sessions) {
            const object = asObject(session);
            const id = stringValue(object?.id) || stringValue(object?.sessionID);
            const title = stringValue(object?.title) || "";
            if (id) rememberSessionObject(object, id);
            if (id && !config.ignoredSessionTitleRe.test(title)) return id;
        }
        return null;
    }

    async function ensureActiveSession(preferredSessionID?: string | null): Promise<string | null> {
        if (preferredSessionID) return preferredSessionID;
        if (activeSessionID) return activeSessionID;
        if (!config.autoCreateSession) return null;
        return await createSession("Discord Remote Control");
    }

    async function classifyForumPost(threadTitle: string, prompt: string): Promise<ForumIntakePlan> {
        if (!opencode.session?.create || !opencode.session?.prompt) {
            await log("warn", "Forum intake classifier skipped because the synchronous OpenCode prompt API is unavailable");
            return normaliseForumIntakePlan(null, threadTitle, prompt, directory);
        }

        let classifierSessionID: string | null = null;
        try {
            const classifier = await callSessionCreate(CLASSIFIER_SESSION_TITLE, directory);
            classifierSessionID = extractSessionID(classifier);
            if (classifierSessionID) {
                ignoredSessions.add(classifierSessionID);
                rememberSessionMetadata(classifierSessionID, {
                    title: CLASSIFIER_SESSION_TITLE,
                    directory,
                    branch: currentBranch,
                });
            }
            if (!classifierSessionID) return normaliseForumIntakePlan(null, threadTitle, prompt, directory);

            const schema = {
                type: "object",
                additionalProperties: false,
                properties: {
                    title: { type: "string" },
                    directory: { type: ["string", "null"] },
                    providerID: { type: ["string", "null"] },
                    modelID: { type: ["string", "null"] },
                    variant: { type: ["string", "null"] },
                    prompt: { type: "string" },
                },
                required: ["title", "directory", "providerID", "modelID", "variant", "prompt"],
            };
            const intakePrompt = [
                "Classify this Discord forum post into an OpenCode session launch plan.",
                "Return only JSON that matches the provided schema.",
                `Current OpenCode directory: ${directory}`,
                "Rules:",
                "- Choose directory by inspecting local files when the post names a repo, project, context, folder, or path.",
                "- Use an absolute directory path. Use null only when the current directory is the right target or the target is unclear.",
                "- providerID/modelID/variant should be null unless the post explicitly asks for a model or variant.",
                "- Keep prompt as the user's actual request, cleaned only enough to remove routing metadata.",
                "- Keep title short and specific.",
                "",
                `Forum post title: ${threadTitle || "untitled"}`,
                "Forum post body:",
                prompt,
            ].join("\n");

            const result = await callSessionPrompt("prompt", classifierSessionID, directory, {
                tools: INTAKE_CLASSIFIER_TOOLS,
                system: "You classify Discord forum posts into OpenCode session launch metadata. You may inspect local files, but you must not modify anything.",
                format: { type: "json_schema", schema, retryCount: 2 },
                parts: [{ type: "text", text: intakePrompt }],
            });
            return normaliseForumIntakePlan(extractStructuredObject(result), threadTitle, prompt, directory);
        } catch (error) {
            await log("warn", "Forum intake classifier failed; falling back to current OpenCode directory", { error: String(error) });
            return normaliseForumIntakePlan(null, threadTitle, prompt, directory);
        } finally {
            if (classifierSessionID) {
                ignoredSessions.add(classifierSessionID);
                void callSessionDelete(classifierSessionID, directory).catch(async (error: unknown) => {
                    await log("debug", "Failed to delete forum intake classifier session", { classifierSessionID, error: String(error) });
                });
            }
        }
    }

    async function createForumSessionFromPost(message: DiscordMessage, thread: ForumThreadState): Promise<void> {
        if (forumIntakes.has(thread.threadID) || threadSessions.has(thread.threadID)) return;
        forumIntakes.add(thread.threadID);

        const postBody = (message.content || "").trim();
        if (!postBody) {
            forumIntakes.delete(thread.threadID);
            await enqueueDiscordMessage(
                embedMessage(makeEmbed({ title: `${ICON.warning} Empty forum post`, description: "Add a prompt in the first post body.", color: EMBED_COLOR.warning })),
                { channelID: thread.threadID },
            );
            return;
        }

        await enqueueDiscordMessage(
            textMessage(transcriptLine("creating opencode session", "reading post and resolving folder/model metadata")),
            { channelID: thread.threadID },
        );

        const plan = await classifyForumPost(thread.name || "Discord forum session", postBody);
        const targetDirectory = plan.directory || directory;
        const sessionID = await createSession(plan.title, targetDirectory);
        if (!sessionID) {
            await enqueueDiscordMessage(
                embedMessage(makeEmbed({ title: `${ICON.error} Failed to create OpenCode session`, color: EMBED_COLOR.error })),
                { channelID: thread.threadID },
            );
            return;
        }

        const branch = await refreshBranch(targetDirectory);
        rememberSessionMetadata(sessionID, {
            title: plan.title,
            directory: targetDirectory,
            branch,
            model: plan.model,
        });
        activeSessionID = sessionID;
        activeSessionLocked = true;
        await bindSessionThread(sessionID, thread.threadID, thread.name);
        await markRuntimeState();
        await announceSessionMetadata(sessionID, "Session created", thread.threadID);

        const promptBody: JsonObject = {
            parts: [{ type: "text", text: plan.prompt }],
        };
        if (config.agent) promptBody.agent = config.agent;
        if (plan.model) {
            promptBody.model = { providerID: plan.model.providerID, modelID: plan.model.modelID };
            if (plan.model.variant) promptBody.variant = plan.model.variant;
        }

        await callSessionPrompt("promptAsync", sessionID, targetDirectory, promptBody);
    }

    async function promptActiveSession(prompt: string, context: CommandContext): Promise<void> {
        const sessionID = await ensureActiveSession(context.sourceSessionID);
        if (!sessionID) {
            replyToCommand(
                context,
                embedMessage(
                    makeEmbed({
                        title: `${ICON.warning} No active session`,
                        description: `Use \`${config.prefix} attach latest\` or \`${config.prefix} new <title>\` first.`,
                        color: EMBED_COLOR.warning,
                    }),
                ),
            );
            return;
        }

        const body: JsonObject = {
            parts: [{ type: "text", text: prompt }],
        };
        if (config.agent) body.agent = config.agent;
        const metadata = metadataForSession(sessionID);
        if (metadata.model) {
            body.model = { providerID: metadata.model.providerID, modelID: metadata.model.modelID };
            if (metadata.model.variant) body.variant = metadata.model.variant;
        }

        await callSessionPrompt("promptAsync", sessionID, metadata.directory || directory, body);

        try {
            if (await reactToCommandSource(context, REACTION.done)) return;
        } catch (error) {
            await log("debug", "Failed to react to Discord prompt source", { sessionID, error: String(error) });
        }
        if (context.silentAck) return;
        replyToCommand(context, textMessage(transcriptLine("queued", shortSessionID(sessionID))), sessionID);
    }

    async function abortActiveSession(context: CommandContext): Promise<void> {
        const sessionID = context.sourceSessionID || activeSessionID;
        if (!sessionID) {
            replyToCommand(context, embedMessage(makeEmbed({ title: `${ICON.warning} No active session to abort`, color: EMBED_COLOR.warning })));
            return;
        }
        await callSessionAbort(sessionID, metadataForSession(sessionID).directory || directory);
        replyToCommand(context, embedMessage(makeEmbed({ title: `${ICON.warning} Abort requested`, color: EMBED_COLOR.warning, sessionID })), sessionID);
    }

    async function replyPermission(requestID: string, reply: PermissionReply, context?: CommandContext): Promise<void> {
        const permission = pendingPermissions.get(requestID);
        if (opencode.permission?.reply) {
            await opencode.permission.reply({ requestID, reply, directory });
        } else if (permission?.sessionID && opencode.postSessionIdPermissionsPermissionId) {
            await opencode.postSessionIdPermissionsPermissionId({
                path: { id: permission.sessionID, permissionID: requestID },
                body: { response: reply },
                query: { directory },
            });
        } else {
            const message = embedMessage(
                makeEmbed({
                    title: `${ICON.error} Permission reply failed`,
                    description: `Could not reply to permission \`${requestID}\`; opencode permission API was not available.`,
                    color: EMBED_COLOR.error,
                    sessionID: permission?.sessionID,
                }),
            );
            if (context) replyToCommand(context, message, permission?.sessionID);
            else relay(message, permission?.sessionID);
            return;
        }
        pendingPermissions.delete(requestID);
        const message = embedMessage(
            makeEmbed({
                title: `${reply === "reject" ? ICON.error : ICON.success} Permission ${reply}`,
                description: `Request \`${requestID}\``,
                color: reply === "reject" ? EMBED_COLOR.error : EMBED_COLOR.success,
                sessionID: permission?.sessionID,
            }),
        );
        if (context) replyToCommand(context, message, permission?.sessionID);
        else relay(message, permission?.sessionID);
    }

    async function listSessions(context: CommandContext): Promise<void> {
        const result = await callSessionList(directory);
        const sessions = asArray(unwrapData(result)).slice(0, 8);
        if (!sessions.length) {
            replyToCommand(context, embedMessage(makeEmbed({ title: `${ICON.info} No sessions returned`, color: EMBED_COLOR.info })));
            return;
        }
        const rows = sessions.map((session) => {
            const object = asObject(session) || {};
            const id = stringValue(object.id) || stringValue(object.sessionID) || "unknown";
            const title = stringValue(object.title) || "untitled";
            const metadata = id !== "unknown" ? rememberSessionObject(object, id) : null;
            const model = metadata?.model ? ` ${modelLabel(metadata.model)}` : "";
            const folder = metadata?.directory ? ` ${formatDirectory(metadata.directory)}` : "";
            return `\`${shortSessionID(id)}\` ${title}${folder}${model}`;
        });
        replyToCommand(
            context,
            embedMessage(
                makeEmbed({
                    title: `${ICON.info} Recent sessions`,
                    description: rows.join("\n"),
                    color: EMBED_COLOR.info,
                }),
            ),
        );
    }

    async function showStatus(context: CommandContext): Promise<void> {
        let statusText = "unknown";
        try {
            const result = await callSessionStatus(directory);
            statusText = truncate(jsonPreview(unwrapData(result), 700), 700) || "unknown";
        } catch (error) {
            statusText = `status call failed: ${String(error)}`;
        }

        await refreshBranch(directory);
        const permissions = [...pendingPermissions.values()].map((permission) => `\`${permission.requestID}\` ${permission.title}`).join("\n");
        const coordinator = coordinatorRuntime();
        const activeMetadata = activeSessionID ? metadataForSession(activeSessionID) : null;

        replyToCommand(
            context,
            embedMessage(
                makeEmbed({
                    title: `${ICON.info} Discord bridge status`,
                    color: EMBED_COLOR.info,
                    fields: [
                        { name: "Active session", value: `\`${shortSessionID(activeSessionID)}\`${activeSessionLocked ? " locked" : ""}` },
                        { name: "Folder", value: inlineCode(formatDirectory(activeMetadata?.directory || directory)), inline: false },
                        { name: "Branch", value: inlineCode(activeMetadata?.branch || currentBranch || "unknown") },
                        { name: "Model/variant", value: inlineCode(modelLabel(activeMetadata?.model)), inline: false },
                        { name: "Thread session", value: `\`${shortSessionID(context.sourceSessionID)}\`` },
                        { name: "Bot user", value: `\`${botUserID || "unknown"}\`` },
                        { name: "Slash command", value: `\`/${config.slashCommand}\`${config.slashCommandsEnabled ? "" : " disabled"}` },
                        { name: "Session threads", value: config.threadsEnabled ? `${config.threadType} (${sessionThreads.size} known)` : "disabled" },
                        { name: "Forum posts", value: config.forumPostsEnabled ? `${forumThreads.size} observed` : "disabled" },
                        { name: "Connected sessions", value: String(connectedSessionCount()) },
                        { name: "Coordinator", value: coordinator ? `pid ${coordinator.pid}` : "none" },
                        { name: "Pending permissions", value: permissions || "none", inline: false },
                        { name: "OpenCode status", value: fenced("json", statusText), inline: false },
                    ],
                }),
            ),
        );
    }

    function helpText(): string {
        return [
            "**opencode Discord remote control**",
            `Slash: \`/${config.slashCommand}\`${config.slashCommandsEnabled ? "" : " (disabled)"}`,
            `Prefix: \`${config.prefix}\``,
            `Session threads: ${config.threadsEnabled ? `${config.threadType} threads` : "disabled"}`,
            `Forum posts: ${config.forumPostsEnabled ? "new posts create sessions" : "disabled"}`,
            `- \`/${config.slashCommand} status\` or \`${config.prefix} status\` - show active session and pending permissions`,
            `- \`/${config.slashCommand} sessions\` or \`${config.prefix} sessions\` - list recent sessions`,
            `- \`/${config.slashCommand} attach [session_id]\` or \`${config.prefix} attach <session-id>\` - select a session`,
            `- \`/${config.slashCommand} new [title]\` or \`${config.prefix} new [title]\` - create and attach a session`,
            `- \`/${config.slashCommand} prompt <text>\` or \`${config.prefix} prompt <text>\` - send text to the selected session`,
            `- \`/${config.slashCommand} abort\` or \`${config.prefix} abort\` - abort the selected session`,
            `- \`/${config.slashCommand} allow [id]\`, \`/${config.slashCommand} always [id]\`, \`/${config.slashCommand} deny [id]\` - answer permissions`,
            config.implicitReply ? "Plain messages from allowed users are treated as replies to the active session." : "Plain messages are ignored; use the prefix.",
        ].join("\n");
    }

    async function handleCommand(message: DiscordMessage, parsed: ParsedCommand, context: CommandContext = {}): Promise<void> {
        const command = parsed.command;
        const rest = parsed.rest;
        await log("info", "Discord command received", {
            command,
            author: message.author?.id || "unknown",
            channelID: message.channel_id || "unknown",
        });

        if (command === "help") {
            replyToCommand(context, embedMessage(makeEmbed({ title: `${ICON.info} OpenCode Discord remote control`, description: helpText(), color: EMBED_COLOR.info })));
            return;
        }
        if (command === "status") {
            await showStatus(context);
            return;
        }
        if (command === "sessions") {
            await listSessions(context);
            return;
        }
        if (command === "attach" || command === "use") {
            const target = rest.trim();
            const sessionID = target === "latest" || !target ? await latestSessionID() : target;
            if (!sessionID) {
                replyToCommand(context, embedMessage(makeEmbed({ title: `${ICON.warning} Could not find a session to attach`, color: EMBED_COLOR.warning })));
                return;
            }
            activeSessionID = sessionID;
            activeSessionLocked = true;
            const metadata = await ensureSessionMetadata(sessionID);
            void markRuntimeState();
            replyToCommand(
                context,
                embedMessage(
                    makeEmbed({
                        title: "Session attached",
                        color: EMBED_COLOR.success,
                        fields: sessionMetadataFields(metadata),
                        sessionID,
                    }),
                ),
                sessionID,
            );
            void announceSessionMetadata(sessionID, "Session context").catch(async (error: unknown) => {
                await log("warn", "Failed to announce attached session metadata", { sessionID, error: String(error) });
            });
            return;
        }
        if (command === "unlock") {
            activeSessionLocked = false;
            replyToCommand(
                context,
                embedMessage(
                    makeEmbed({
                        title: `${ICON.success} Auto attach unlocked`,
                        description: `Current session: \`${shortSessionID(activeSessionID)}\``,
                        color: EMBED_COLOR.success,
                    }),
                ),
            );
            return;
        }
        if (command === "new") {
            const title = rest || "Discord Remote Control";
            const sessionID = await createSession(title);
            const metadata = sessionID ? metadataForSession(sessionID) : null;
            replyToCommand(
                context,
                embedMessage(
                    makeEmbed({
                        title: sessionID ? `${ICON.success} Created session` : `${ICON.error} Failed to create session`,
                        description: title,
                        color: sessionID ? EMBED_COLOR.success : EMBED_COLOR.error,
                        fields: metadata ? sessionMetadataFields(metadata) : undefined,
                        sessionID,
                    }),
                ),
                sessionID,
            );
            return;
        }
        if (command === "prompt" || command === "reply") {
            if (!rest) {
                replyToCommand(
                    context,
                    embedMessage(
                        makeEmbed({
                            title: `${ICON.info} Prompt usage`,
                            description: `Use \`${config.prefix} ${command} <text>\`, \`/${config.slashCommand} ${command} text:<text>\`, or type directly in a session thread.`,
                            color: EMBED_COLOR.info,
                        }),
                    ),
                );
                return;
            }
            await promptActiveSession(rest, context);
            return;
        }
        if (command === "abort") {
            await abortActiveSession(context);
            return;
        }
        if (["allow", "always", "deny", "reject"].includes(command)) {
            const requestID = rest || [...pendingPermissions.keys()][0] || "";
            if (!requestID) {
                replyToCommand(context, embedMessage(makeEmbed({ title: `${ICON.info} No pending permission request`, color: EMBED_COLOR.info })));
                return;
            }
            const reply = command === "always" ? "always" : command === "allow" ? "once" : "reject";
            await replyPermission(requestID, reply, context);
            return;
        }

        replyToCommand(
            context,
            embedMessage(
                makeEmbed({
                    title: `${ICON.warning} Unknown command`,
                    description: `Unknown command \`${command}\`. Use \`${config.prefix} help\` or \`/${config.slashCommand} help\`.`,
                    color: EMBED_COLOR.warning,
                }),
            ),
        );
    }

    async function handleDiscordMessage(message: DiscordMessage): Promise<void> {
        const pendingForumThread = forumThreadForMessage(message);
        if (!isAllowedDiscordChannel(message.channel_id) && !pendingForumThread) return;
        if (message.author?.bot) return;
        if (botUserID && message.author?.id === botUserID) return;
        if (!message.author?.id || !config.allowedUserIDs.has(message.author.id)) return;

        if (pendingForumThread && !threadSessions.has(pendingForumThread.threadID)) {
            await createForumSessionFromPost(message, pendingForumThread);
            return;
        }

        const sourceSessionID = sessionIDForDiscordChannel(message.channel_id);
        if (sourceSessionID) {
            if (!localOwnsSession(sourceSessionID)) return;
        } else if (!(await isCoordinatorRuntime())) {
            return;
        }

        const parsed = parseDiscordRemoteCommand(message.content || "", config.prefix, config.implicitReply);
        if (!parsed) return;

        try {
            await handleCommand(message, parsed, {
                sourceChannelID: message.channel_id || null,
                sourceMessageID: message.id || null,
                sourceSessionID,
            });
        } catch (error) {
            await log("error", "Failed to handle Discord command", { error: String(error) });
            replyToCommand({ sourceChannelID: message.channel_id || null }, `Discord command failed: ${String(error)}`);
        }
    }

    async function handleDiscordInteraction(interaction: DiscordInteraction): Promise<void> {
        if (interaction.type === DISCORD_INTERACTION_PING) {
            await pongInteraction(interaction);
            return;
        }

        if (interaction.type !== DISCORD_INTERACTION_APPLICATION_COMMAND) return;
        const parsed = parseSlashInteraction(interaction, config.slashCommand);
        if (!parsed) return;

        const userID = interactionUserID(interaction);
        if (!userID || !config.allowedUserIDs.has(userID)) {
            await respondInteraction(interaction, "This Discord user is not allowed to control opencode.", true);
            return;
        }

        if (!isAllowedDiscordChannel(interaction.channel_id)) {
            await respondInteraction(interaction, "Use this command in the configured opencode control channel or one of its session threads.", true);
            return;
        }

        const sourceSessionID = sessionIDForDiscordChannel(interaction.channel_id);
        if (sourceSessionID) {
            if (!localOwnsSession(sourceSessionID)) return;
        } else if (!(await isCoordinatorRuntime())) {
            return;
        }

        const context: CommandContext = {
            sourceChannelID: interaction.channel_id || null,
            sourceSessionID,
            silentAck: true,
        };

        await respondInteraction(
            interaction,
            `Accepted \`/${config.slashCommand} ${parsed.command}\`. Output will be posted in this channel or the linked session thread.`,
        );

        try {
            await handleCommand(
                {
                    channel_id: interaction.channel_id,
                    guild_id: interaction.guild_id,
                    author: { id: userID },
                },
                parsed,
                context,
            );
        } catch (error) {
            await log("error", "Failed to handle Discord slash command", { error: String(error) });
            replyToCommand(context, `Discord slash command failed: ${String(error)}`);
        }
    }

    function clearHeartbeat(): void {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (heartbeatStartTimer) clearTimeout(heartbeatStartTimer);
        heartbeatTimer = null;
        heartbeatStartTimer = null;
    }

    function sendGateway(payload: DiscordGatewayPayload): void {
        if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
        websocket.send(JSON.stringify(payload));
    }

    function sendPresence(): void {
        if (!config.presenceEnabled) return;
        const count = connectedSessionCount();
        const noun = count === 1 ? "session" : "sessions";
        sendGateway({
            op: 3,
            d: {
                since: null,
                activities: [
                    {
                        name: `${count} opencode ${noun}`,
                        type: 3,
                    },
                ],
                status: count > 0 ? "online" : "idle",
                afk: false,
            },
        });
    }

    function sendHeartbeat(): void {
        if (!heartbeatAcked) {
            try {
                websocket?.close(4000, "heartbeat ack timeout");
            } catch {
                // Reconnect path handles a closed or zombied gateway.
            }
            return;
        }
        heartbeatAcked = false;
        sendGateway({ op: 1, d: lastSequence });
    }

    function startHeartbeat(intervalMs: number): void {
        clearHeartbeat();
        heartbeatAcked = true;
        const jitter = Math.random() * intervalMs;
        heartbeatStartTimer = setTimeout(() => {
            sendHeartbeat();
            heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
        }, jitter);
    }

    function identifyGateway(): void {
        sendGateway({
            op: 2,
            d: {
                token: config.token,
                intents: DEFAULT_INTENTS,
                properties: {
                    os: typeof process !== "undefined" ? process.platform : "unknown",
                    browser: PLUGIN,
                    device: PLUGIN,
                },
            },
        });
    }

    function resumeGateway(): boolean {
        if (!gatewaySessionID || lastSequence === null) return false;
        sendGateway({
            op: 6,
            d: {
                token: config.token,
                session_id: gatewaySessionID,
                seq: lastSequence,
            },
        });
        return true;
    }

    async function dataToText(data: unknown): Promise<string | null> {
        if (typeof data === "string") return data;
        if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
        if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
        return null;
    }

    async function handleGatewayPayload(payload: DiscordGatewayPayload): Promise<void> {
        if (typeof payload.s === "number") lastSequence = payload.s;

        if (payload.op === 10) {
            const data = asObject(payload.d) || {};
            const interval = numberValue(data.heartbeat_interval, 45000, 1000, 120000);
            startHeartbeat(interval);
            if (!resumeGateway()) identifyGateway();
            return;
        }

        if (payload.op === 11) {
            heartbeatAcked = true;
            return;
        }

        if (payload.op === 7) {
            websocket?.close(4000, "discord reconnect requested");
            return;
        }

        if (payload.op === 9) {
            const canResume = payload.d === true;
            if (!canResume) {
                gatewaySessionID = null;
                resumeGatewayURL = null;
                lastSequence = null;
            }
            websocket?.close(4000, "discord invalid session");
            return;
        }

        if (payload.op !== 0) return;

        if (payload.t === "READY") {
            const data = asObject(payload.d) || {};
            const user = asObject(data.user) || {};
            const application = asObject(data.application) || {};
            botUserID = stringValue(user.id);
            applicationID = applicationID || stringValue(application.id);
            gatewaySessionID = stringValue(data.session_id);
            resumeGatewayURL = stringValue(data.resume_gateway_url);
            reconnectAttempts = 0;
            if (applicationID) {
                void registerSlashCommand(applicationID).catch(async (error: unknown) => {
                    await log("warn", "Failed to register Discord slash command", { error: String(error) });
                    relay(
                        embedMessage(
                            makeEmbed({
                                title: `${ICON.warning} Slash command registration failed`,
                                description: String(error),
                                color: EMBED_COLOR.warning,
                            }),
                        ),
                    );
                });
            } else if (config.slashCommandsEnabled && config.registerSlashCommands) {
                await log("warn", "Discord slash command registration skipped because application ID is unknown");
            }
            await markRuntimeState();
            return;
        }

        if (payload.t === "RESUMED") {
            reconnectAttempts = 0;
            await markRuntimeState();
            return;
        }

        if (payload.t === "MESSAGE_CREATE") {
            await handleDiscordMessage((asObject(payload.d) || {}) as DiscordMessage);
            return;
        }

        if (payload.t === "THREAD_CREATE") {
            rememberForumThread((asObject(payload.d) || {}) as DiscordChannel);
            return;
        }

        if (payload.t === "INTERACTION_CREATE") {
            await handleDiscordInteraction((asObject(payload.d) || {}) as DiscordInteraction);
        }
    }

    async function getGatewayURL(): Promise<string> {
        const result = await discordFetch("/gateway/bot", { method: "GET" });
        const data = asObject(result) || {};
        const url = stringValue(data.url);
        if (!url) throw new Error("Discord gateway response did not include a URL");
        return url;
    }

    async function connectGateway(useResumeURL = false): Promise<void> {
        if (typeof WebSocket === "undefined") {
            await log("error", "WebSocket global is unavailable; Discord remote control cannot connect");
            return;
        }

        const baseURL = useResumeURL && resumeGatewayURL ? resumeGatewayURL : await getGatewayURL();
        const url = new URL(baseURL);
        url.searchParams.set("v", DISCORD_GATEWAY_VERSION);
        url.searchParams.set("encoding", "json");

        websocket = new WebSocket(url.toString());
        websocket.addEventListener("message", (event: MessageEvent) => {
            void (async () => {
                const text = await dataToText(event.data);
                if (!text) return;
                await handleGatewayPayload(JSON.parse(text) as DiscordGatewayPayload);
            })().catch(async (error: unknown) => {
                await log("error", "Failed to handle Discord gateway payload", { error: String(error) });
            });
        });
        websocket.addEventListener("close", (event: CloseEvent) => {
            clearHeartbeat();
            const fatalReason = FATAL_GATEWAY_CLOSE_CODES.get(event.code);
            if (fatalReason) {
                gatewayStopped = true;
                void log("error", "Discord gateway closed with a fatal code", { code: event.code, reason: fatalReason });
                void toast("Discord bridge stopped", `${event.code}: ${fatalReason}`, "error");
                return;
            }
            if (gatewayStopped) return;
            const attempt = reconnectAttempts++;
            const delay = Math.min(config.reconnectMaxMs, config.reconnectBaseMs * 2 ** Math.min(attempt, 6));
            setTimeout(() => {
                if (gatewayStopped) return;
                void connectGateway(Boolean(resumeGatewayURL && gatewaySessionID)).catch(async (error: unknown) => {
                    await log("error", "Discord gateway reconnect failed", { error: String(error) });
                });
            }, delay);
        });
        websocket.addEventListener("error", () => {
            void log("warn", "Discord gateway websocket emitted an error");
        });
    }

    function flushStreamBuffer(key: string): void {
        const buffer = streamBuffers.get(key);
        if (!buffer) return;
        if (buffer.timer) clearTimeout(buffer.timer);
        streamBuffers.delete(key);
        const text = stripSystemReminders(buffer.text);
        if (!text) return;
        relay(transcriptStreamMessage(buffer.kind, text), buffer.sessionID);
    }

    function bufferStream(sessionID: string, partID: string, kind: "assistant" | "thinking", delta: string): void {
        if (!delta) return;
        const key = `${sessionID}:${partID}:${kind}`;
        const buffer = streamBuffers.get(key) || { sessionID, partID, kind, text: "", timer: null };
        buffer.text += delta;
        if (!buffer.timer) {
            buffer.timer = setTimeout(() => flushStreamBuffer(key), config.streamFlushMs);
        }
        streamBuffers.set(key, buffer);
    }

    function flushSessionBuffers(sessionID: string): void {
        for (const [key, buffer] of streamBuffers.entries()) {
            if (buffer.sessionID === sessionID) flushStreamBuffer(key);
        }
    }

    function handleSessionCreated(event: JsonObject): void {
        const sessionID = sessionIDFromEvent(event);
        if (!sessionID) return;
        const title = titleFromEvent(event) || "untitled";
        const properties = asObject(event.properties) || {};
        rememberSessionObject(asObject(properties.info), sessionID);
        rememberSessionMetadata(sessionID, { title });
        if (config.ignoredSessionTitleRe.test(title)) {
            ignoredSessions.add(sessionID);
            return;
        }
        if (config.autoAttachLatest && !activeSessionLocked) {
            activeSessionID = sessionID;
            void markRuntimeState();
            relay(
                embedMessage(
                    makeEmbed({
                        title: "Session attached",
                        description: title,
                        color: EMBED_COLOR.success,
                        sessionID,
                    }),
                ),
                sessionID,
            );
        }
    }

    function handleSessionUpdated(event: JsonObject): void {
        const sessionID = sessionIDFromEvent(event);
        if (!sessionID) return;
        const properties = asObject(event.properties) || {};
        const metadata = rememberSessionObject(asObject(properties.info), sessionID) || metadataForSession(sessionID);
        const title = metadata.title || titleFromEvent(event) || "untitled";
        if (config.ignoredSessionTitleRe.test(title)) {
            ignoredSessions.add(sessionID);
            return;
        }
        if (!shouldRelaySession(sessionID)) return;
        void syncSessionThreadMetadata(sessionID).catch(async (error: unknown) => {
            await log("warn", "Failed to sync updated session metadata", { sessionID, error: String(error) });
        });
    }

    function handlePermissionEvent(event: JsonObject): void {
        const properties = asObject(event.properties) || {};
        const requestID = stringValue(properties.id) || stringValue(properties.requestID) || stringValue(properties.permissionID);
        if (!requestID) return;
        const sessionID = stringValue(properties.sessionID) || null;
        if (sessionID && !shouldRelaySession(sessionID)) return;

        const patterns = asArray(properties.patterns || properties.pattern || properties.always)
            .map((entry) => String(entry))
            .filter(Boolean);
        const title = stringValue(properties.title) || stringValue(properties.permission) || "Permission request";
        const permission = { requestID, sessionID, title, patterns };
        pendingPermissions.set(requestID, permission);
        relay(embedMessage(formatPermissionEmbed(permission, config.prefix, config.slashCommand)), sessionID);
    }

    function handlePartUpdated(event: JsonObject): void {
        const properties = asObject(event.properties) || {};
        const part = asObject(properties.part);
        if (!part) return;

        const sessionID = stringValue(part.sessionID) || stringValue(part.sessionId) || sessionIDFromEvent(event);
        if (!sessionID || !shouldRelaySession(sessionID)) return;

        const type = stringValue(part.type);
        const partID = stringValue(part.id) || "part";
        if (type === "text") {
            bufferStream(sessionID, partID, "assistant", getPartDelta(sessionID, partID, "assistant", part, properties, textProgress));
            return;
        }
        if (type === "reasoning" && config.includeReasoning) {
            bufferStream(sessionID, partID, "thinking", getPartDelta(sessionID, partID, "thinking", part, properties, textProgress));
            return;
        }
        if (type === "step-start") {
            relayReaction(REACTION.step, sessionID);
            return;
        }
        if (type === "step-finish") {
            relayReaction(REACTION.done, sessionID);
            return;
        }
        if (type === "patch") {
            const files = asArray(part.files).map((file) => `- ${String(file)}`).join("\n");
            relay(embedMessage(makeEmbed({ title: `${ICON.patch} Patch`, description: files || "no files", color: EMBED_COLOR.info, sessionID })), sessionID);
            return;
        }
        if (type === "agent") {
            const name = stringValue(part.name) || "agent";
            relay(embedMessage(makeEmbed({ title: `${ICON.agent} Agent`, description: name, color: EMBED_COLOR.info, sessionID })), sessionID);
            return;
        }
        if (type === "compaction") {
            relayReaction(REACTION.status, sessionID);
            return;
        }
    }

    function handlePartDelta(event: JsonObject): void {
        // OpenCode delta events do not include the part type, so a reasoning
        // delta can look like normal text until the matching part update arrives.
        // Relay from message.part.updated instead; it has the part type and the
        // progress tracker still emits only the unseen suffix.
    }

    function rememberMessageMetadata(sessionID: string, message: JsonObject): void {
        const model = modelFromMessage(message);
        const path = asObject(message.path);
        const cwd = stringValue(path?.cwd) || stringValue(path?.root);
        rememberSessionMetadata(sessionID, {
            directory: cwd || metadataForSession(sessionID).directory || directory,
            model: model || metadataForSession(sessionID).model,
        });
    }

    function handleMessageUpdated(event: JsonObject): void {
        const properties = asObject(event.properties) || {};
        const sessionID = stringValue(properties.sessionID) || stringValue(properties.sessionId);
        const info = asObject(properties.info);
        if (!sessionID || !info) return;
        rememberMessageMetadata(sessionID, info);
        if (!shouldRelaySession(sessionID)) return;
        void syncSessionThreadMetadata(sessionID).catch(async (error: unknown) => {
            await log("warn", "Failed to sync message metadata", { sessionID, error: String(error) });
        });
    }

    function handleSessionEvent(event: JsonObject): void {
        const sessionID = sessionIDFromEvent(event);
        if (!sessionID || !shouldRelaySession(sessionID)) return;
        const type = stringValue(event.type) || "event";
        if (type === "session.idle") {
            flushSessionBuffers(sessionID);
            relayReaction(REACTION.idle, sessionID);
            return;
        }
        if (type === "session.error") {
            relay(
                embedMessage(
                    makeEmbed({
                        title: "Session error",
                        description: fenced("json", jsonPreview(asObject(event.properties) || {}, 1200)),
                        color: EMBED_COLOR.error,
                        sessionID,
                    }),
                ),
                sessionID,
            );
            return;
        }
        if (type === "session.status") {
            relayReaction(REACTION.status, sessionID);
            return;
        }
        if (type === "session.compacted") {
            relayReaction(REACTION.status, sessionID);
        }
    }

    function handleTodoUpdated(event: JsonObject): void {
        const sessionID = sessionIDFromEvent(event);
        if (!shouldRelaySession(sessionID)) return;
        relayReaction(REACTION.todo, sessionID);
    }

    await log("info", "Plugin initialised", {
        enabled: config.enabled,
        channelID: config.channelID || "missing",
        inboundEnabled: config.allowedUserIDs.size > 0,
        initialSessionID: activeSessionID || "none",
        slashCommand: config.slashCommandsEnabled ? `/${config.slashCommand}` : "disabled",
        threadsEnabled: config.threadsEnabled,
        forumPostsEnabled: config.forumPostsEnabled,
    });

    if (!config.enabled) {
        await log("warn", "Discord plugin disabled because token or channel ID is missing");
        return {};
    }

    await loadPersistentState();
    await markRuntimeState(false);
    presenceTimer = setInterval(() => {
        void markRuntimeState().catch(async (error: unknown) => {
            await log("warn", "Failed to refresh Discord runtime presence", { error: String(error) });
        });
    }, config.presenceUpdateMs);
    process.once("beforeExit", () => {
        if (presenceTimer) clearInterval(presenceTimer);
        void removeRuntimeState().catch(() => undefined);
    });

    if (config.allowedUserIDs.size === 0) {
        await log("warn", "Discord inbound control disabled because OPENCODE_DISCORD_ALLOWED_USER_IDS is empty");
    }

    void connectGateway(false).catch(async (error: unknown) => {
        await log("error", "Discord gateway connection failed", { error: String(error) });
    });

    void toast("Discord bridge starting", `Channel ${config.channelID}; active ${shortSessionID(activeSessionID)}.`, "info");

    return {
        event: async ({ event }: PluginEventInput) => {
            const object = event as JsonObject;
            const type = stringValue(object.type);
            if (!type) return;

            if (type === "session.created") {
                handleSessionCreated(object);
                return;
            }
            if (type === "session.updated") {
                handleSessionUpdated(object);
                return;
            }
            if (type === "message.part.updated") {
                handlePartUpdated(object);
                return;
            }
            if (type === "message.updated") {
                handleMessageUpdated(object);
                return;
            }
            if (type === "message.part.delta") {
                handlePartDelta(object);
                return;
            }
            if (type === "permission.asked" || type === "permission.updated") {
                handlePermissionEvent(object);
                return;
            }
            if (type === "permission.replied") {
                const properties = asObject(object.properties) || {};
                const requestID = stringValue(properties.requestID) || stringValue(properties.permissionID);
                if (requestID) pendingPermissions.delete(requestID);
                return;
            }
            if (type === "todo.updated") {
                handleTodoUpdated(object);
                return;
            }
            if (type.startsWith("session.")) {
                handleSessionEvent(object);
            }
        },

        "chat.message": async (input: ChatMessageHookInput) => {
            const sessionID = stringValue(input.sessionID);
            if (!sessionID) return;
            rememberModelMetadata(sessionID, modelFromValue(input.model, input.variant));
            if (!shouldRelaySession(sessionID)) return;
            await syncSessionThreadMetadata(sessionID).catch(async (error: unknown) => {
                await log("warn", "Failed to sync chat model metadata", { sessionID, error: String(error) });
            });
        },

        "tool.execute.before": async (input: ToolExecuteHookInput) => {
            const sessionID = stringValue(input.sessionID);
            if (!shouldRelaySession(sessionID)) return;
            const callID = stringValue(input.callID) || "unknown";
            const key = `${sessionID}:${callID}:before`;
            if (seenToolStates.has(key)) return;
            seenToolStates.add(key);
        },

        "tool.execute.after": async (input: ToolExecuteHookInput, output: unknown) => {
            const sessionID = stringValue(input.sessionID);
            if (!shouldRelaySession(sessionID)) return;
            const callID = stringValue(input.callID) || "unknown";
            const tool = stringValue(input.tool) || "tool";
            const key = `${sessionID}:${callID}:after`;
            if (seenToolStates.has(key)) return;
            seenToolStates.add(key);
            const result = output as JsonObject;
            const failed = toolOutputFailed(result);
            if (!failed && !isImportantTool(tool)) return;
            flushSessionBuffers(sessionID);
            relayReaction(failed ? REACTION.failed : REACTION.done, sessionID);
            relay(formatToolResultMessage(tool, callID, input.args, result, config.maxToolOutputChars, config.includeToolOutput, failed), sessionID);
        },
    };
};
