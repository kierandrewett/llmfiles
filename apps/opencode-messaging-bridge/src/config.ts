import path from "node:path";

const DEFAULT_OPENCODE_COMMAND = "opencode";
const DEFAULT_OPENCODE_HOST = "127.0.0.1";
const DEFAULT_OPENCODE_PORT = 4096;
const DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_DISCORD_PREFIX = "!oc";
const DEFAULT_DISCORD_SLASH_COMMAND = "oc";
const DEFAULT_DISCORD_MAX_MESSAGE_CHARS = 1850;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL = "openai/whisper-1";
const DEFAULT_VOICE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_INTENT_RESOLVER_MAX_TURNS = 4;
const DEFAULT_INTENT_RESOLVER_TTL_MS = 10 * 60 * 1000;
const STATE_DIR_NAME = "opencode-messaging-bridge";
const STATE_FILE_NAME = "state.json";

export interface OpenCodeProcessConfig {
    manage: boolean;
    command: string;
    host: string;
    port: number;
    workdir: string | null;
    startupTimeoutMs: number;
}

export interface BridgeConfig {
    opencode: {
        baseUrl: string;
        process: OpenCodeProcessConfig;
    };
    statePath: string;
    implicitReply: boolean;
    telegram: {
        enabled: boolean;
        botToken: string | null;
        allowedUserIDs: string[];
        allowedChatIDs: string[];
        createTopics: boolean;
    };
    discord: {
        enabled: boolean;
        botToken: string | null;
        applicationID: string | null;
        guildID: string | null;
        allowedUserIDs: string[];
        controlChannelID: string | null;
        prefix: string;
        slashCommand: string;
        registerSlashCommands: boolean;
        slashResponsesEphemeral: boolean;
        messageContentIntent: boolean;
        maxMessageChars: number;
    };
    workspace: {
        root: string | null;
    };
    intentResolver: {
        enabled: boolean;
        maxClarificationTurns: number;
        clarificationTtlMs: number;
    };
    voice: {
        enabled: boolean;
        maxAudioBytes: number;
        openrouter: {
            apiKey: string | null;
            baseUrl: string;
            model: string;
            language: string | null;
        };
    };
}

export type Env = Partial<Record<string, string | undefined>>;

export function parseIDList(value: string | undefined): string[] {
    if (!value) {
        return [];
    }

    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

export function defaultStatePath(env: Env = process.env): string {
    const stateRoot = env.XDG_STATE_HOME?.trim();
    if (stateRoot) {
        return path.join(stateRoot, STATE_DIR_NAME, STATE_FILE_NAME);
    }

    const home = env.HOME?.trim();
    if (!home) {
        throw new Error("HOME must be set when OPENCODE_BRIDGE_STATE_PATH and XDG_STATE_HOME are not configured");
    }

    return path.join(home, ".local", "state", STATE_DIR_NAME, STATE_FILE_NAME);
}

export function loadBridgeConfig(env: Env = process.env): BridgeConfig {
    const opencodeProcess = loadOpenCodeProcessConfig(env);
    const opencodeBaseUrl = normaliseBaseUrl(
        env.OPENCODE_BRIDGE_OPENCODE_BASE_URL ?? defaultOpenCodeBaseUrl(opencodeProcess),
        "OPENCODE_BRIDGE_OPENCODE_BASE_URL",
    );
    const statePath = env.OPENCODE_BRIDGE_STATE_PATH?.trim() || defaultStatePath(env);
    const telegramAllowedUserIDs = parseIDList(env.OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS);
    const telegramAllowedChatIDs = parseIDList(env.OPENCODE_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS);
    const discordAllowedUserIDs = parseIDList(env.OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS);
    const telegramBotToken = readSecret(env.OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN);
    const discordBotToken = readSecret(env.OPENCODE_BRIDGE_DISCORD_BOT_TOKEN);
    const discordControlChannelID = readOptionalString(env.OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID);
    const workspaceRoot = readOptionalAbsolutePath(env.OPENCODE_BRIDGE_WORKSPACE_ROOT, "OPENCODE_BRIDGE_WORKSPACE_ROOT");
    const intentResolverEnabled = parseBoolean(env.OPENCODE_BRIDGE_INTENT_RESOLVER);
    if (intentResolverEnabled && workspaceRoot === null) {
        throw new Error("OPENCODE_BRIDGE_WORKSPACE_ROOT must be set when OPENCODE_BRIDGE_INTENT_RESOLVER is enabled");
    }
    const voiceEnabled = parseBoolean(env.OPENCODE_BRIDGE_VOICE_TRANSCRIPTION);
    const openrouterApiKey = readSecret(env.OPENCODE_BRIDGE_OPENROUTER_API_KEY);
    if (voiceEnabled && openrouterApiKey === null) {
        throw new Error("OPENCODE_BRIDGE_OPENROUTER_API_KEY must be set when OPENCODE_BRIDGE_VOICE_TRANSCRIPTION is enabled");
    }

    return {
        opencode: {
            baseUrl: opencodeBaseUrl,
            process: opencodeProcess,
        },
        statePath,
        implicitReply: parseBoolean(env.OPENCODE_BRIDGE_IMPLICIT_REPLY),
        telegram: {
            enabled: telegramBotToken !== null && telegramAllowedUserIDs.length > 0,
            botToken: telegramBotToken,
            allowedUserIDs: telegramAllowedUserIDs,
            allowedChatIDs: telegramAllowedChatIDs,
            createTopics: parseBoolean(env.OPENCODE_BRIDGE_TELEGRAM_CREATE_TOPICS),
        },
        discord: {
            enabled: discordBotToken !== null && discordControlChannelID !== null && discordAllowedUserIDs.length > 0,
            botToken: discordBotToken,
            applicationID: readOptionalString(env.OPENCODE_BRIDGE_DISCORD_APPLICATION_ID),
            guildID: readOptionalString(env.OPENCODE_BRIDGE_DISCORD_GUILD_ID),
            allowedUserIDs: discordAllowedUserIDs,
            controlChannelID: discordControlChannelID,
            prefix: readRequiredString(env.OPENCODE_BRIDGE_DISCORD_PREFIX, DEFAULT_DISCORD_PREFIX, "OPENCODE_BRIDGE_DISCORD_PREFIX"),
            slashCommand: readDiscordSlashCommand(env.OPENCODE_BRIDGE_DISCORD_SLASH_COMMAND),
            registerSlashCommands: parseBoolean(env.OPENCODE_BRIDGE_DISCORD_REGISTER_SLASH_COMMANDS),
            slashResponsesEphemeral: parseBooleanDefault(env.OPENCODE_BRIDGE_DISCORD_SLASH_EPHEMERAL, true),
            messageContentIntent: parseBoolean(env.OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT),
            maxMessageChars: parseIntegerInRange(
                env.OPENCODE_BRIDGE_DISCORD_MAX_MESSAGE_CHARS,
                DEFAULT_DISCORD_MAX_MESSAGE_CHARS,
                500,
                1990,
                "OPENCODE_BRIDGE_DISCORD_MAX_MESSAGE_CHARS",
            ),
        },
        workspace: {
            root: workspaceRoot,
        },
        intentResolver: {
            enabled: intentResolverEnabled,
            maxClarificationTurns: parseIntegerInRange(
                env.OPENCODE_BRIDGE_INTENT_RESOLVER_MAX_TURNS,
                DEFAULT_INTENT_RESOLVER_MAX_TURNS,
                1,
                10,
                "OPENCODE_BRIDGE_INTENT_RESOLVER_MAX_TURNS",
            ),
            clarificationTtlMs: parseIntegerInRange(
                env.OPENCODE_BRIDGE_INTENT_RESOLVER_TTL_MS,
                DEFAULT_INTENT_RESOLVER_TTL_MS,
                1000,
                86400000,
                "OPENCODE_BRIDGE_INTENT_RESOLVER_TTL_MS",
            ),
        },
        voice: {
            enabled: voiceEnabled,
            maxAudioBytes: parseIntegerInRange(
                env.OPENCODE_BRIDGE_VOICE_MAX_AUDIO_BYTES,
                DEFAULT_VOICE_MAX_AUDIO_BYTES,
                1,
                DEFAULT_VOICE_MAX_AUDIO_BYTES,
                "OPENCODE_BRIDGE_VOICE_MAX_AUDIO_BYTES",
            ),
            openrouter: {
                apiKey: openrouterApiKey,
                baseUrl: normaliseHttpsBaseUrl(
                    env.OPENCODE_BRIDGE_OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL,
                    "OPENCODE_BRIDGE_OPENROUTER_BASE_URL",
                ),
                model: readRequiredString(
                    env.OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_MODEL,
                    DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL,
                    "OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_MODEL",
                ),
                language: readOptionalNoWhitespace(
                    env.OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_LANGUAGE,
                    "OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_LANGUAGE",
                ),
            },
        },
    };
}

function loadOpenCodeProcessConfig(env: Env): OpenCodeProcessConfig {
    return {
        manage: parseBoolean(env.OPENCODE_BRIDGE_MANAGE_OPENCODE),
        command: readRequiredString(
            env.OPENCODE_BRIDGE_OPENCODE_COMMAND,
            DEFAULT_OPENCODE_COMMAND,
            "OPENCODE_BRIDGE_OPENCODE_COMMAND",
        ),
        host: readRequiredString(
            env.OPENCODE_BRIDGE_OPENCODE_HOST,
            DEFAULT_OPENCODE_HOST,
            "OPENCODE_BRIDGE_OPENCODE_HOST",
        ),
        port: parseIntegerInRange(
            env.OPENCODE_BRIDGE_OPENCODE_PORT,
            DEFAULT_OPENCODE_PORT,
            1,
            65535,
            "OPENCODE_BRIDGE_OPENCODE_PORT",
        ),
        workdir: readOptionalString(env.OPENCODE_BRIDGE_OPENCODE_WORKDIR),
        startupTimeoutMs: parsePositiveInteger(
            env.OPENCODE_BRIDGE_OPENCODE_STARTUP_TIMEOUT_MS,
            DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS,
            "OPENCODE_BRIDGE_OPENCODE_STARTUP_TIMEOUT_MS",
        ),
    };
}

function defaultOpenCodeBaseUrl(config: OpenCodeProcessConfig): string {
    return `http://${hostForClientUrl(config.host)}:${String(config.port)}`;
}

function hostForClientUrl(host: string): string {
    if (host === "0.0.0.0" || host === "::") {
        return DEFAULT_OPENCODE_HOST;
    }
    if (host.includes(":") && !host.startsWith("[")) {
        return `[${host}]`;
    }

    return host;
}

function normaliseBaseUrl(value: string, envName: string): string {
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("unsupported protocol");
        }
        if (url.username || url.password) {
            throw new Error("credentials are not allowed");
        }

        return url.toString().replace(/\/+$/, "");
    } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`${envName} must be a valid URL${reason}`);
    }
}

function normaliseHttpsBaseUrl(value: string, envName: string): string {
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:") {
            throw new Error("unsupported protocol");
        }
        if (url.username || url.password) {
            throw new Error("credentials are not allowed");
        }

        return url.toString().replace(/\/+$/, "");
    } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`${envName} must be a valid URL${reason}`);
    }
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) {
        return false;
    }

    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseBooleanDefault(value: string | undefined, fallback: boolean): boolean {
    if (!value) {
        return fallback;
    }

    return parseBoolean(value);
}

function readDiscordSlashCommand(value: string | undefined): string {
    const command = readRequiredString(
        value,
        DEFAULT_DISCORD_SLASH_COMMAND,
        "OPENCODE_BRIDGE_DISCORD_SLASH_COMMAND",
    ).toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(command)) {
        throw new Error("OPENCODE_BRIDGE_DISCORD_SLASH_COMMAND must be 1-32 lowercase letters, numbers, dashes, or underscores");
    }

    return command;
}

function parseIntegerInRange(value: string | undefined, fallback: number, min: number, max: number, envName: string): number {
    const parsed = parseInteger(value, fallback, envName);
    if (parsed < min || parsed > max) {
        throw new Error(`${envName} must be an integer between ${String(min)} and ${String(max)}`);
    }

    return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, envName: string): number {
    const parsed = parseInteger(value, fallback, envName);
    if (parsed <= 0) {
        throw new Error(`${envName} must be an integer greater than 0`);
    }

    return parsed;
}

function parseInteger(value: string | undefined, fallback: number, envName: string): number {
    const trimmed = value?.trim();
    if (!trimmed) {
        return fallback;
    }

    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${envName} must be an integer`);
    }

    return parsed;
}

function readSecret(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}

function readOptionalString(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}

function readOptionalAbsolutePath(value: string | undefined, envName: string): string | null {
    const trimmed = value?.trim();
    if (!trimmed) {
        return null;
    }
    if (!path.isAbsolute(trimmed)) {
        throw new Error(`${envName} must be an absolute path`);
    }

    return path.resolve(trimmed);
}

function readOptionalNoWhitespace(value: string | undefined, envName: string): string | null {
    const trimmed = value?.trim();
    if (!trimmed) {
        return null;
    }
    if (/\s/.test(trimmed)) {
        throw new Error(`${envName} must not contain whitespace`);
    }

    return trimmed;
}

function readRequiredString(value: string | undefined, fallback: string, envName: string): string {
    const trimmed = value?.trim();
    if (!trimmed) {
        return fallback;
    }
    if (/\s/.test(trimmed)) {
        throw new Error(`${envName} must not contain whitespace`);
    }

    return trimmed;
}
