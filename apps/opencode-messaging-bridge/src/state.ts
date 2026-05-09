import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type BridgePlatform = "telegram" | "discord";

export interface BridgeSurfaceAddress {
    chatID?: string;
    channelID?: string;
    threadID: string | null;
    messageID?: string | null;
}

export interface BridgeSurfaceState {
    id: string;
    platform: BridgePlatform;
    surface: BridgeSurfaceAddress;
    activeSessionID: string | null;
    updatedAt: string;
}

export interface BridgeBindingState {
    id: string;
    platform: BridgePlatform;
    surface: BridgeSurfaceAddress;
    sessionID: string;
    directory: string | null;
    title: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface BridgeState {
    version: 1;
    updatedAt: string;
    platforms: {
        telegram: {
            updateOffset: number | null;
        };
        discord: {
            gatewaySessionID: string | null;
            resumeGatewayUrl: string | null;
            sequence: number | null;
        };
    };
    surfaces: BridgeSurfaceState[];
    bindings: BridgeBindingState[];
    deliveries: Record<string, unknown>[];
}

export function createDefaultBridgeState(now = new Date()): BridgeState {
    return {
        version: 1,
        updatedAt: now.toISOString(),
        platforms: {
            telegram: {
                updateOffset: null,
            },
            discord: {
                gatewaySessionID: null,
                resumeGatewayUrl: null,
                sequence: null,
            },
        },
        surfaces: [],
        bindings: [],
        deliveries: [],
    };
}

export async function loadOrCreateBridgeState(filePath: string, now = new Date()): Promise<BridgeState> {
    try {
        return await readBridgeState(filePath);
    } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
        }

        const state = createDefaultBridgeState(now);
        await writeBridgeState(filePath, state);
        return state;
    }
}

export async function readBridgeState(filePath: string): Promise<BridgeState> {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseJsonObject(raw, filePath);
    return parseBridgeState(parsed, filePath);
}

export async function writeBridgeState(filePath: string, state: BridgeState): Promise<void> {
    const parsed = parseBridgeState(state, filePath);
    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

    await mkdir(directory, { recursive: true });

    try {
        await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        await rename(tempPath, filePath);
    } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
    }
}

function parseBridgeState(value: unknown, source: string): BridgeState {
    const record = requireRecord(value, source);
    const version = record.version;
    if (version !== 1) {
        throw new Error(`Unsupported bridge state version in ${source}: ${String(version)}`);
    }

    const platforms = requireRecord(record.platforms, `${source}.platforms`);
    const telegram = requireRecord(platforms.telegram, `${source}.platforms.telegram`);
    const discord = requireRecord(platforms.discord, `${source}.platforms.discord`);

    return {
        version: 1,
        updatedAt: requireString(record.updatedAt, `${source}.updatedAt`),
        platforms: {
            telegram: {
                updateOffset: requireNullableNumber(telegram.updateOffset, `${source}.platforms.telegram.updateOffset`),
            },
            discord: {
                gatewaySessionID: requireNullableString(discord.gatewaySessionID, `${source}.platforms.discord.gatewaySessionID`),
                resumeGatewayUrl: requireNullableString(discord.resumeGatewayUrl, `${source}.platforms.discord.resumeGatewayUrl`),
                sequence: requireNullableNumber(discord.sequence, `${source}.platforms.discord.sequence`),
            },
        },
        surfaces: requireArray(record.surfaces, `${source}.surfaces`).map((entry, index) => parseSurfaceState(entry, `${source}.surfaces[${index}]`)),
        bindings: requireArray(record.bindings, `${source}.bindings`).map((entry, index) => parseBindingState(entry, `${source}.bindings[${index}]`)),
        deliveries: requireArray(record.deliveries, `${source}.deliveries`).map((entry, index) => requireRecord(entry, `${source}.deliveries[${index}]`)),
    };
}

function parseSurfaceState(value: unknown, source: string): BridgeSurfaceState {
    const record = requireRecord(value, source);

    return {
        id: requireString(record.id, `${source}.id`),
        platform: requirePlatform(record.platform, `${source}.platform`),
        surface: parseSurfaceAddress(record.surface, `${source}.surface`),
        activeSessionID: requireNullableString(record.activeSessionID, `${source}.activeSessionID`),
        updatedAt: requireString(record.updatedAt, `${source}.updatedAt`),
    };
}

function parseBindingState(value: unknown, source: string): BridgeBindingState {
    const record = requireRecord(value, source);

    return {
        id: requireString(record.id, `${source}.id`),
        platform: requirePlatform(record.platform, `${source}.platform`),
        surface: parseSurfaceAddress(record.surface, `${source}.surface`),
        sessionID: requireString(record.sessionID, `${source}.sessionID`),
        directory: requireNullableString(record.directory, `${source}.directory`),
        title: requireNullableString(record.title, `${source}.title`),
        createdAt: requireString(record.createdAt, `${source}.createdAt`),
        updatedAt: requireString(record.updatedAt, `${source}.updatedAt`),
    };
}

function parseSurfaceAddress(value: unknown, source: string): BridgeSurfaceAddress {
    const record = requireRecord(value, source);
    const chatID = readOptionalString(record.chatID, `${source}.chatID`);
    const channelID = readOptionalString(record.channelID, `${source}.channelID`);

    if (!chatID && !channelID) {
        throw new Error(`${source} must include chatID or channelID`);
    }

    const address: BridgeSurfaceAddress = {
        threadID: requireNullableString(record.threadID, `${source}.threadID`),
    };
    const messageID = readOptionalNullableString(record.messageID, `${source}.messageID`);

    if (chatID) {
        address.chatID = chatID;
    }
    if (channelID) {
        address.channelID = channelID;
    }
    if (messageID !== undefined) {
        address.messageID = messageID;
    }

    return address;
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
    try {
        return requireRecord(JSON.parse(raw) as unknown, source);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse bridge state ${source}: ${reason}`);
    }
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`${source} must be an object`);
    }

    return value;
}

function requireArray(value: unknown, source: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${source} must be an array`);
    }

    return value;
}

function requireString(value: unknown, source: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${source} must be a non-empty string`);
    }

    return value;
}

function requireNullableString(value: unknown, source: string): string | null {
    if (value === null) {
        return null;
    }

    return requireString(value, source);
}

function requireNullableNumber(value: unknown, source: string): number | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${source} must be a finite number or null`);
    }

    return value;
}

function requirePlatform(value: unknown, source: string): BridgePlatform {
    if (value === "telegram" || value === "discord") {
        return value;
    }

    throw new Error(`${source} must be telegram or discord`);
}

function readOptionalString(value: unknown, source: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    return requireString(value, source);
}

function readOptionalNullableString(value: unknown, source: string): string | null | undefined {
    if (value === undefined) {
        return undefined;
    }

    return requireNullableString(value, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
