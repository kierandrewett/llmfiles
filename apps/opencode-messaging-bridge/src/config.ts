import path from "node:path";

const DEFAULT_OPENCODE_BASE_URL = "http://127.0.0.1:4096";
const STATE_DIR_NAME = "opencode-messaging-bridge";
const STATE_FILE_NAME = "state.json";

export interface BridgeConfig {
    opencode: {
        baseUrl: string;
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
    const opencodeBaseUrl = normaliseBaseUrl(
        env.OPENCODE_BRIDGE_OPENCODE_BASE_URL ?? DEFAULT_OPENCODE_BASE_URL,
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

function readSecret(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}

function readOptionalString(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}
