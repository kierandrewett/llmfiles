import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN = "discord-remote-control";
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY_VERSION = "10";
const DEFAULT_PREFIX = "!oc";
const DEFAULT_SLASH_COMMAND = "oc";
const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const DEFAULT_IGNORED_SESSION_TITLE_RE = /Generate git commit message/i;
const DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES = 1440;
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
const FATAL_GATEWAY_CLOSE_CODES = new Map([
    [4004, "authentication failed; check OPENCODE_DISCORD_BOT_TOKEN"],
    [4010, "invalid shard"],
    [4013, "invalid intents"],
    [4014, "disallowed intents; enable the Message Content intent or reduce requested intents"],
]);

type JsonObject = Record<string, unknown>;

type LogLevel = "debug" | "info" | "warn" | "error";
type PermissionReply = "once" | "always" | "reject";
type ThreadType = "public" | "private";

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
        get?: SessionMethod;
        list?: SessionMethod;
        promptAsync?: SessionMethod;
        status?: SessionMethod;
    };
    permission?: {
        reply?: SessionMethod;
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
    statePath: string;
    initialSessionID: string | null;
    agent: string | null;
    maxMessageChars: number;
    maxToolOutputChars: number;
    streamFlushMs: number;
    sendDelayMs: number;
    reconnectBaseMs: number;
    reconnectMaxMs: number;
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
    id?: string;
    channel_id?: string;
    guild_id?: string;
    content?: string;
    author?: DiscordUser;
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
    sourceSessionID?: string | null;
};

type DiscordTarget = {
    channelID?: string | null;
    sessionID?: string | null;
};

type PersistentState = {
    version: 1;
    registrations: Record<string, string>;
    threads: Record<string, Record<string, string>>;
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

function safeThreadName(prefix: string, sessionID: string, title: string | null | undefined): string {
    const suffix = (title || "session")
        .replace(/[^a-zA-Z0-9._ -]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 56);
    const name = `${prefix} ${shortSessionID(sessionID)}${suffix ? ` ${suffix}` : ""}`
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
    return name || `${prefix} ${shortSessionID(sessionID)}`.slice(0, 100);
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
        includeToolOutput: optionBool(pluginOptions, "includeToolOutput", ["OPENCODE_DISCORD_INCLUDE_TOOL_OUTPUT"], true),
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
        statePath: optionString(pluginOptions, "statePath", ["OPENCODE_DISCORD_STATE_PATH"], defaultStatePath()),
        initialSessionID: optionString(pluginOptions, "sessionID", ["OPENCODE_DISCORD_SESSION_ID"]) || null,
        agent: optionString(pluginOptions, "agent", ["OPENCODE_DISCORD_AGENT"]) || null,
        maxMessageChars: optionNumber(pluginOptions, "maxMessageChars", ["OPENCODE_DISCORD_MAX_MESSAGE_CHARS"], 1850, 500, 1990),
        maxToolOutputChars: optionNumber(pluginOptions, "maxToolOutputChars", ["OPENCODE_DISCORD_MAX_TOOL_OUTPUT_CHARS"], 1400, 200, 6000),
        streamFlushMs: optionNumber(pluginOptions, "streamFlushMs", ["OPENCODE_DISCORD_STREAM_FLUSH_MS"], 1200, 250, 10000),
        sendDelayMs: optionNumber(pluginOptions, "sendDelayMs", ["OPENCODE_DISCORD_SEND_DELAY_MS"], 750, 50, 10000),
        reconnectBaseMs: optionNumber(pluginOptions, "reconnectBaseMs", ["OPENCODE_DISCORD_RECONNECT_BASE_MS"], 1500, 250, 60000),
        reconnectMaxMs: optionNumber(pluginOptions, "reconnectMaxMs", ["OPENCODE_DISCORD_RECONNECT_MAX_MS"], 60000, 1000, 300000),
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

function fenced(language: string, content: string): string {
    const safe = content.replace(/```/g, "` ` `");
    return `\`\`\`${language}\n${safe}\n\`\`\``;
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

function partKey(part: JsonObject): string {
    const sessionID = stringValue(part.sessionID) || stringValue(part.sessionId) || "unknown-session";
    const messageID = stringValue(part.messageID) || stringValue(part.messageId) || "unknown-message";
    const partID = stringValue(part.id) || "unknown-part";
    return `${sessionID}:${messageID}:${partID}`;
}

function getPartDelta(part: JsonObject, properties: JsonObject, progress: Map<string, TextPartProgress>): string {
    const explicitDelta = stringValue(properties.delta);
    if (explicitDelta !== null) {
        const currentText = stringValue(part.text) || "";
        progress.set(partKey(part), { length: currentText.length });
        return explicitDelta;
    }

    const text = stringValue(part.text) || "";
    const key = partKey(part);
    const previous = progress.get(key)?.length || 0;
    progress.set(key, { length: text.length });
    if (text.length <= previous) return "";
    return text.slice(previous);
}

function formatToolStart(tool: string, sessionID: string, callID: string, args: unknown, maxChars: number): string {
    const parts = [`**tool start** \`${tool}\` in \`${shortSessionID(sessionID)}\``, `call: \`${callID || "unknown"}\``];
    const preview = jsonPreview(args, maxChars);
    if (preview) parts.push(fenced("json", preview));
    return parts.join("\n");
}

function formatToolDone(tool: string, sessionID: string, callID: string, output: JsonObject, maxChars: number, includeOutput: boolean): string {
    const title = stringValue(output.title) || tool;
    const rows = [`**tool done** \`${tool}\` in \`${shortSessionID(sessionID)}\``, `call: \`${callID || "unknown"}\``, `title: ${title}`];
    if (includeOutput) {
        const rendered = stringValue(output.output) || jsonPreview(output.metadata, maxChars);
        if (rendered) rows.push(fenced("text", truncate(rendered, maxChars)));
    }
    return rows.join("\n");
}

function formatPermission(permission: PendingPermission, prefix = DEFAULT_PREFIX, slashCommand = DEFAULT_SLASH_COMMAND): string {
    const patterns = permission.patterns.length ? permission.patterns.join(", ") : "no patterns";
    return [
        `**permission asked** \`${permission.requestID}\` in \`${shortSessionID(permission.sessionID)}\``,
        permission.title,
        `patterns: ${patterns}`,
        `Reply with \`${prefix} allow ${permission.requestID}\`, \`${prefix} always ${permission.requestID}\`, \`${prefix} deny ${permission.requestID}\`, or \`/${slashCommand} allow id:${permission.requestID}\`.`,
    ].join("\n");
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DiscordRemoteControl: Plugin = async ({ client, directory }, options) => {
    const config = parseConfig(options);
    const opencode = client as OpenCodeClientLike;
    const pendingPermissions = new Map<string, PendingPermission>();
    const ignoredSessions = new Set<string>();
    const textProgress = new Map<string, TextPartProgress>();
    const streamBuffers = new Map<string, StreamBuffer>();
    const seenToolStates = new Set<string>();
    const sessionTitles = new Map<string, string>();
    const sessionThreads = new Map<string, string>();
    const threadSessions = new Map<string, string>();
    const threadCreatePromises = new Map<string, Promise<string | null>>();
    const threadFailures = new Set<string>();
    let persistentState: PersistentState = { version: 1, registrations: {}, threads: {} };
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

    function threadStateKey(): string {
        return `${config.channelID}:${config.threadType}`;
    }

    function registrationStateKey(id: string): string {
        return `${id}:${config.guildID || "global"}:${config.slashCommand}`;
    }

    function hydrateThreadState(): void {
        const threads = persistentState.threads[threadStateKey()] || {};
        for (const [sessionID, threadID] of Object.entries(threads)) {
            if (!sessionID || !threadID) continue;
            sessionThreads.set(sessionID, threadID);
            threadSessions.set(threadID, sessionID);
        }
    }

    async function loadPersistentState(): Promise<void> {
        try {
            const raw = await readFile(config.statePath, "utf8");
            const parsed = asObject(JSON.parse(raw));
            const registrations = asObject(parsed?.registrations) || {};
            const threads = asObject(parsed?.threads) || {};
            persistentState = {
                version: 1,
                registrations: Object.fromEntries(Object.entries(registrations).map(([key, value]) => [key, String(value)])),
                threads: Object.fromEntries(
                    Object.entries(threads).map(([key, value]) => {
                        const mapping = asObject(value) || {};
                        return [key, Object.fromEntries(Object.entries(mapping).map(([sessionID, threadID]) => [sessionID, String(threadID)]))];
                    }),
                ),
            };
            hydrateThreadState();
        } catch (error) {
            const code = asObject(error)?.code;
            if (code !== "ENOENT") await log("warn", "Failed to load Discord plugin state; starting with empty state", { error: String(error) });
            persistentState = { version: 1, registrations: {}, threads: {} };
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

    async function persistThreadMapping(sessionID: string, threadID: string): Promise<void> {
        const key = threadStateKey();
        persistentState.threads[key] = {
            ...(persistentState.threads[key] || {}),
            [sessionID]: threadID,
        };
        await savePersistentState();
    }

    async function discordFetch(route: string, init: RequestInit = {}): Promise<unknown> {
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

        persistentState.registrations[stateKey] = signature;
        await savePersistentState();
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
        return Boolean(channelID && (channelID === config.channelID || threadSessions.has(channelID)));
    }

    async function createSessionThread(sessionID: string): Promise<string | null> {
        const existing = sessionThreads.get(sessionID);
        if (existing) return existing;
        if (threadCreatePromises.has(sessionID)) return await threadCreatePromises.get(sessionID)!;

        const promise = (async () => {
            try {
                const result = await discordFetch(`/channels/${config.channelID}/threads`, {
                    method: "POST",
                    body: JSON.stringify({
                        name: safeThreadName(config.threadNamePrefix, sessionID, sessionTitles.get(sessionID)),
                        auto_archive_duration: config.threadAutoArchiveMinutes,
                        type: threadTypeCode(config.threadType),
                    }),
                });
                const thread = asObject(result) || {};
                const threadID = stringValue(thread.id);
                if (!threadID) throw new Error("Discord thread creation response did not include an id");

                sessionThreads.set(sessionID, threadID);
                threadSessions.set(threadID, sessionID);
                await persistThreadMapping(sessionID, threadID);
                return threadID;
            } catch (error) {
                if (!threadFailures.has(sessionID)) {
                    threadFailures.add(sessionID);
                    await log("warn", "Failed to create Discord session thread; falling back to control channel", {
                        sessionID,
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

    async function targetChannelID(target: DiscordTarget): Promise<string> {
        if (target.channelID) return target.channelID;
        if (!config.threadsEnabled || !target.sessionID) return config.channelID;
        return (await createSessionThread(target.sessionID)) || config.channelID;
    }

    async function sendDiscordMessage(content: string, target: DiscordTarget = {}): Promise<void> {
        if (!content.trim()) return;

        const channelID = await targetChannelID(target);

        for (const chunk of splitDiscordContent(content, config.maxMessageChars)) {
            await discordFetch(`/channels/${channelID}/messages`, {
                method: "POST",
                body: JSON.stringify({
                    content: chunk,
                    allowed_mentions: { parse: [] },
                }),
            });
        }
    }

    function enqueueDiscordMessage(content: string, target: DiscordTarget = {}): Promise<void> {
        sendQueue = sendQueue
            .then(async () => {
                await sendDiscordMessage(content, target);
                await sleep(config.sendDelayMs);
            })
            .catch(async (error: unknown) => {
                await log("error", "Failed to send Discord message", { error: String(error) });
            });
        return sendQueue;
    }

    function relay(content: string, sessionID?: string | null): void {
        void enqueueDiscordMessage(content, { sessionID });
    }

    function replyToCommand(context: CommandContext, content: string, sessionID?: string | null): void {
        void enqueueDiscordMessage(content, { channelID: context.sourceChannelID || null, sessionID });
    }

    function isSessionIgnored(sessionID: string | null): boolean {
        return Boolean(sessionID && ignoredSessions.has(sessionID));
    }

    function shouldRelaySession(sessionID: string | null): boolean {
        if (!sessionID || isSessionIgnored(sessionID)) return false;
        if (!activeSessionID && config.autoAttachLatest) {
            activeSessionID = sessionID;
            activeSessionLocked = false;
            relay(`**attached** \`${shortSessionID(sessionID)}\` from first opencode event.`, sessionID);
            return true;
        }
        return activeSessionID === sessionID;
    }

    async function createSession(title: string): Promise<string | null> {
        const result = await opencode.session?.create?.({
            body: { title },
            query: { directory },
        });
        const sessionID = extractSessionID(result);
        if (sessionID) {
            activeSessionID = sessionID;
            activeSessionLocked = true;
            sessionTitles.set(sessionID, title);
        }
        return sessionID;
    }

    async function latestSessionID(): Promise<string | null> {
        const result = await opencode.session?.list?.({ query: { directory } });
        const data = unwrapData(result);
        const sessions = asArray(data);
        for (const session of sessions) {
            const object = asObject(session);
            const id = stringValue(object?.id) || stringValue(object?.sessionID);
            const title = stringValue(object?.title) || "";
            if (id) sessionTitles.set(id, title || "untitled");
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

    async function promptActiveSession(prompt: string, context: CommandContext): Promise<void> {
        const sessionID = await ensureActiveSession(context.sourceSessionID);
        if (!sessionID) {
            replyToCommand(context, `No active session. Use \`${config.prefix} attach latest\` or \`${config.prefix} new <title>\` first.`);
            return;
        }

        const body: JsonObject = {
            parts: [{ type: "text", text: prompt }],
        };
        if (config.agent) body.agent = config.agent;

        await opencode.session?.promptAsync?.({
            path: { id: sessionID },
            body,
            query: { directory },
        });

        replyToCommand(context, `**prompt queued** \`${shortSessionID(sessionID)}\``, sessionID);
    }

    async function abortActiveSession(context: CommandContext): Promise<void> {
        const sessionID = context.sourceSessionID || activeSessionID;
        if (!sessionID) {
            replyToCommand(context, "No active session to abort.");
            return;
        }
        await opencode.session?.abort?.({
            path: { id: sessionID },
            query: { directory },
        });
        replyToCommand(context, `**abort requested** \`${shortSessionID(sessionID)}\``, sessionID);
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
            const message = `Could not reply to permission \`${requestID}\`; opencode permission API was not available.`;
            if (context) replyToCommand(context, message, permission?.sessionID);
            else relay(message, permission?.sessionID);
            return;
        }
        pendingPermissions.delete(requestID);
        const message = `**permission ${reply}** \`${requestID}\``;
        if (context) replyToCommand(context, message, permission?.sessionID);
        else relay(message, permission?.sessionID);
    }

    async function listSessions(context: CommandContext): Promise<void> {
        const result = await opencode.session?.list?.({ query: { directory } });
        const sessions = asArray(unwrapData(result)).slice(0, 8);
        if (!sessions.length) {
            replyToCommand(context, "No sessions returned by opencode.");
            return;
        }
        const rows = sessions.map((session) => {
            const object = asObject(session) || {};
            const id = stringValue(object.id) || stringValue(object.sessionID) || "unknown";
            const title = stringValue(object.title) || "untitled";
            if (id !== "unknown") sessionTitles.set(id, title);
            return `- \`${shortSessionID(id)}\` ${title}`;
        });
        replyToCommand(context, ["**recent sessions**", ...rows].join("\n"));
    }

    async function showStatus(context: CommandContext): Promise<void> {
        let statusText = "unknown";
        try {
            const result = await opencode.session?.status?.({ query: { directory } });
            statusText = truncate(jsonPreview(unwrapData(result), 700), 700) || "unknown";
        } catch (error) {
            statusText = `status call failed: ${String(error)}`;
        }

        const permissions = [...pendingPermissions.values()]
            .map((permission) => `- \`${permission.requestID}\` ${permission.title}`)
            .join("\n");

        replyToCommand(
            context,
            [
                `**discord bridge status**`,
                `active session: \`${shortSessionID(activeSessionID)}\`${activeSessionLocked ? " (locked)" : ""}`,
                `thread session: \`${shortSessionID(context.sourceSessionID)}\``,
                `bot user: \`${botUserID || "unknown"}\``,
                `slash command: \`/${config.slashCommand}\`${config.slashCommandsEnabled ? "" : " (disabled)"}`,
                `session threads: ${config.threadsEnabled ? `${config.threadType} (${sessionThreads.size} known)` : "disabled"}`,
                `pending permissions:\n${permissions || "none"}`,
                fenced("json", statusText),
            ].join("\n"),
        );
    }

    function helpText(): string {
        return [
            "**opencode Discord remote control**",
            `Slash: \`/${config.slashCommand}\`${config.slashCommandsEnabled ? "" : " (disabled)"}`,
            `Prefix: \`${config.prefix}\``,
            `Session threads: ${config.threadsEnabled ? `${config.threadType} threads` : "disabled"}`,
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
            replyToCommand(context, helpText());
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
                replyToCommand(context, "Could not find a session to attach.");
                return;
            }
            activeSessionID = sessionID;
            activeSessionLocked = true;
            replyToCommand(context, `**attached** \`${shortSessionID(sessionID)}\``, sessionID);
            return;
        }
        if (command === "unlock") {
            activeSessionLocked = false;
            replyToCommand(context, `**auto attach unlocked** current \`${shortSessionID(activeSessionID)}\``);
            return;
        }
        if (command === "new") {
            const title = rest || "Discord Remote Control";
            const sessionID = await createSession(title);
            replyToCommand(context, sessionID ? `**created session** \`${shortSessionID(sessionID)}\` ${title}` : "Failed to create session.", sessionID);
            return;
        }
        if (command === "prompt" || command === "reply") {
            if (!rest) {
                replyToCommand(context, `Usage: \`${config.prefix} ${command} <text>\` or \`/${config.slashCommand} ${command} text:<text>\`.`);
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
                replyToCommand(context, "No pending permission request found.");
                return;
            }
            const reply = command === "always" ? "always" : command === "allow" ? "once" : "reject";
            await replyPermission(requestID, reply, context);
            return;
        }

        replyToCommand(context, `Unknown command \`${command}\`. Use \`${config.prefix} help\` or \`/${config.slashCommand} help\`.`);
    }

    async function handleDiscordMessage(message: DiscordMessage): Promise<void> {
        if (!isAllowedDiscordChannel(message.channel_id)) return;
        if (message.author?.bot) return;
        if (botUserID && message.author?.id === botUserID) return;
        if (!message.author?.id || !config.allowedUserIDs.has(message.author.id)) return;

        const parsed = parseDiscordRemoteCommand(message.content || "", config.prefix, config.implicitReply);
        if (!parsed) return;

        try {
            await handleCommand(message, parsed, {
                sourceChannelID: message.channel_id || null,
                sourceSessionID: sessionIDForDiscordChannel(message.channel_id),
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

        const context: CommandContext = {
            sourceChannelID: interaction.channel_id || null,
            sourceSessionID: sessionIDForDiscordChannel(interaction.channel_id),
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
                    relay(`Discord slash command registration failed: ${String(error)}`);
                });
            } else if (config.slashCommandsEnabled && config.registerSlashCommands) {
                await log("warn", "Discord slash command registration skipped because application ID is unknown");
            }
            relay(`**Discord bridge connected** bot \`${botUserID || "unknown"}\`, active \`${shortSessionID(activeSessionID)}\`.`);
            return;
        }

        if (payload.t === "RESUMED") {
            reconnectAttempts = 0;
            relay("**Discord bridge resumed**");
            return;
        }

        if (payload.t === "MESSAGE_CREATE") {
            await handleDiscordMessage((asObject(payload.d) || {}) as DiscordMessage);
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
        const text = buffer.text.trim();
        if (!text) return;
        relay(`**${buffer.kind}** \`${shortSessionID(buffer.sessionID)}\`\n${text}`, buffer.sessionID);
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
        sessionTitles.set(sessionID, title);
        if (config.ignoredSessionTitleRe.test(title)) {
            ignoredSessions.add(sessionID);
            return;
        }
        if (config.autoAttachLatest && !activeSessionLocked) {
            activeSessionID = sessionID;
            relay(`**attached** \`${shortSessionID(sessionID)}\` ${title}`, sessionID);
        }
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
        relay(formatPermission(permission, config.prefix, config.slashCommand), sessionID);
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
            bufferStream(sessionID, partID, "assistant", getPartDelta(part, properties, textProgress));
            return;
        }
        if (type === "reasoning" && config.includeReasoning) {
            bufferStream(sessionID, partID, "thinking", getPartDelta(part, properties, textProgress));
            return;
        }
        if (type === "step-start") {
            relay(`**step start** \`${shortSessionID(sessionID)}\``, sessionID);
            return;
        }
        if (type === "step-finish") {
            const reason = stringValue(part.reason) || "done";
            relay(`**step finish** \`${shortSessionID(sessionID)}\` ${reason}`, sessionID);
            return;
        }
        if (type === "patch") {
            const files = asArray(part.files).map((file) => `- ${String(file)}`).join("\n");
            relay(`**patch** \`${shortSessionID(sessionID)}\`\n${files || "no files"}`, sessionID);
            return;
        }
        if (type === "agent") {
            const name = stringValue(part.name) || "agent";
            relay(`**agent** \`${shortSessionID(sessionID)}\` ${name}`, sessionID);
        }
    }

    function handlePartDelta(event: JsonObject): void {
        const properties = asObject(event.properties) || {};
        const sessionID = stringValue(properties.sessionID) || stringValue(properties.sessionId);
        if (!sessionID || !shouldRelaySession(sessionID)) return;

        const partID = stringValue(properties.partID) || stringValue(properties.partId) || "part";
        const field = stringValue(properties.field) || "text";
        const delta = stringValue(properties.delta) || "";
        const kind = field.toLowerCase().includes("reason") ? "thinking" : "assistant";
        if (kind === "thinking" && !config.includeReasoning) return;
        bufferStream(sessionID, partID, kind, delta);
    }

    function handleSessionEvent(event: JsonObject): void {
        const sessionID = sessionIDFromEvent(event);
        if (!sessionID || !shouldRelaySession(sessionID)) return;
        const type = stringValue(event.type) || "event";
        if (type === "session.idle") {
            flushSessionBuffers(sessionID);
            relay(`**idle** \`${shortSessionID(sessionID)}\``, sessionID);
            return;
        }
        if (type === "session.error") {
            relay(`**session error** \`${shortSessionID(sessionID)}\`\n${fenced("json", jsonPreview(asObject(event.properties) || {}, 1200))}`, sessionID);
            return;
        }
        if (type === "session.status") {
            const status = asObject(asObject(event.properties)?.status) || asObject(event.properties) || {};
            relay(`**status** \`${shortSessionID(sessionID)}\` ${jsonPreview(status, 500)}`, sessionID);
            return;
        }
        if (type === "session.compacted") {
            relay(`**compacted** \`${shortSessionID(sessionID)}\``, sessionID);
        }
    }

    function handleTodoUpdated(event: JsonObject): void {
        const sessionID = sessionIDFromEvent(event);
        if (!shouldRelaySession(sessionID)) return;
        relay(`**todo updated** \`${shortSessionID(sessionID)}\`\n${fenced("json", jsonPreview(asObject(event.properties) || {}, 1200))}`, sessionID);
    }

    await log("info", "Plugin initialised", {
        enabled: config.enabled,
        channelID: config.channelID || "missing",
        inboundEnabled: config.allowedUserIDs.size > 0,
        initialSessionID: activeSessionID || "none",
        slashCommand: config.slashCommandsEnabled ? `/${config.slashCommand}` : "disabled",
        threadsEnabled: config.threadsEnabled,
    });

    if (!config.enabled) {
        await log("warn", "Discord plugin disabled because token or channel ID is missing");
        return {};
    }

    await loadPersistentState();

    if (config.allowedUserIDs.size === 0) {
        await log("warn", "Discord inbound control disabled because OPENCODE_DISCORD_ALLOWED_USER_IDS is empty");
    }

    void connectGateway(false).catch(async (error: unknown) => {
        await log("error", "Discord gateway connection failed", { error: String(error) });
    });

    void toast("Discord bridge starting", `Channel ${config.channelID}; active ${shortSessionID(activeSessionID)}.`, "info");

    return {
        event: async ({ event }) => {
            const object = event as JsonObject;
            const type = stringValue(object.type);
            if (!type) return;

            if (type === "session.created") {
                handleSessionCreated(object);
                return;
            }
            if (type === "message.part.updated") {
                handlePartUpdated(object);
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

        "tool.execute.before": async (input, output) => {
            const sessionID = input.sessionID;
            if (!shouldRelaySession(sessionID)) return;
            const callID = input.callID;
            const key = `${sessionID}:${callID}:before`;
            if (seenToolStates.has(key)) return;
            seenToolStates.add(key);
            relay(formatToolStart(input.tool, sessionID, callID, output.args, config.maxToolOutputChars), sessionID);
        },

        "tool.execute.after": async (input, output) => {
            const sessionID = input.sessionID;
            if (!shouldRelaySession(sessionID)) return;
            const callID = input.callID;
            const key = `${sessionID}:${callID}:after`;
            if (seenToolStates.has(key)) return;
            seenToolStates.add(key);
            relay(formatToolDone(input.tool, sessionID, callID, output as JsonObject, config.maxToolOutputChars, config.includeToolOutput), sessionID);
        },
    };
};
