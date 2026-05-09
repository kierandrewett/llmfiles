import path from "node:path";

const DEFAULT_OPENCODE_COMMAND = "opencode";
const DEFAULT_OPENCODE_HOST = "127.0.0.1";
const DEFAULT_OPENCODE_PORT = 4096;
const DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS = 30000;
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
    };
    discord: {
        enabled: boolean;
        botToken: string | null;
        applicationID: string | null;
        allowedUserIDs: string[];
        controlChannelID: string | null;
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
        },
        discord: {
            enabled: discordBotToken !== null && discordControlChannelID !== null && discordAllowedUserIDs.length > 0,
            botToken: discordBotToken,
            applicationID: readOptionalString(env.OPENCODE_BRIDGE_DISCORD_APPLICATION_ID),
            allowedUserIDs: discordAllowedUserIDs,
            controlChannelID: discordControlChannelID,
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

function parseBoolean(value: string | undefined): boolean {
    if (!value) {
        return false;
    }

    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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
