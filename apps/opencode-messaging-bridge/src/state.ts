import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type BridgePlatform = "telegram" | "discord";

export interface BridgeSurfaceAddress {
    chatID?: string;
    channelID?: string;
    chatType?: string;
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

export interface BridgeScheduledJobState {
    id: string;
    platform: BridgePlatform;
    surfaceID: string;
    surface: BridgeSurfaceAddress;
    sessionID: string;
    prompt: string;
    intervalMinutes: number;
    nextRunAt: string;
    lastRunAt: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface BridgeIntentResolverClarificationOptionState {
    id: string;
    label: string;
    value?: string;
}

export interface BridgeIntentResolverState {
    id: string;
    platform: BridgePlatform;
    surfaceID: string;
    surface: BridgeSurfaceAddress;
    userID: string;
    resolverSessionID: string;
    workspaceRoot: string;
    originalText: string;
    turnCount: number;
    maxTurns: number;
    expiresAt: string;
    lastQuestion: string;
    allowFreeText: boolean;
    options: BridgeIntentResolverClarificationOptionState[];
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
    jobs: BridgeScheduledJobState[];
    intentResolvers: BridgeIntentResolverState[];
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
        jobs: [],
        intentResolvers: [],
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
        jobs: readOptionalArray(record.jobs, `${source}.jobs`).map((entry, index) => parseScheduledJobState(entry, `${source}.jobs[${index}]`)),
        intentResolvers: readOptionalArray(record.intentResolvers, `${source}.intentResolvers`).map((entry, index) => parseIntentResolverState(entry, `${source}.intentResolvers[${index}]`)),
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

function parseScheduledJobState(value: unknown, source: string): BridgeScheduledJobState {
    const record = requireRecord(value, source);

    return {
        id: requireString(record.id, `${source}.id`),
        platform: requirePlatform(record.platform, `${source}.platform`),
        surfaceID: requireString(record.surfaceID, `${source}.surfaceID`),
        surface: parseSurfaceAddress(record.surface, `${source}.surface`),
        sessionID: requireString(record.sessionID, `${source}.sessionID`),
        prompt: requireString(record.prompt, `${source}.prompt`),
        intervalMinutes: requirePositiveInteger(record.intervalMinutes, `${source}.intervalMinutes`),
        nextRunAt: requireString(record.nextRunAt, `${source}.nextRunAt`),
        lastRunAt: requireNullableString(record.lastRunAt, `${source}.lastRunAt`),
        lastError: requireNullableString(record.lastError, `${source}.lastError`),
        createdAt: requireString(record.createdAt, `${source}.createdAt`),
        updatedAt: requireString(record.updatedAt, `${source}.updatedAt`),
    };
}

function parseIntentResolverState(value: unknown, source: string): BridgeIntentResolverState {
    const record = requireRecord(value, source);

    return {
        id: requireString(record.id, `${source}.id`),
        platform: requirePlatform(record.platform, `${source}.platform`),
        surfaceID: requireString(record.surfaceID, `${source}.surfaceID`),
        surface: parseSurfaceAddress(record.surface, `${source}.surface`),
        userID: requireString(record.userID, `${source}.userID`),
        resolverSessionID: requireString(record.resolverSessionID, `${source}.resolverSessionID`),
        workspaceRoot: requireString(record.workspaceRoot, `${source}.workspaceRoot`),
        originalText: requireString(record.originalText, `${source}.originalText`),
        turnCount: requirePositiveInteger(record.turnCount, `${source}.turnCount`),
        maxTurns: requirePositiveInteger(record.maxTurns, `${source}.maxTurns`),
        expiresAt: requireString(record.expiresAt, `${source}.expiresAt`),
        lastQuestion: requireString(record.lastQuestion, `${source}.lastQuestion`),
        allowFreeText: readOptionalBoolean(record.allowFreeText, `${source}.allowFreeText`) ?? false,
        options: requireArray(record.options, `${source}.options`).map((entry, index) => parseIntentResolverOptionState(entry, `${source}.options[${index}]`)),
        createdAt: requireString(record.createdAt, `${source}.createdAt`),
        updatedAt: requireString(record.updatedAt, `${source}.updatedAt`),
    };
}

function parseIntentResolverOptionState(value: unknown, source: string): BridgeIntentResolverClarificationOptionState {
    const record = requireRecord(value, source);
    const option: BridgeIntentResolverClarificationOptionState = {
        id: requireString(record.id, `${source}.id`),
        label: requireString(record.label, `${source}.label`),
    };
    const optionValue = readOptionalString(record.value, `${source}.value`);
    if (optionValue !== undefined) {
        option.value = optionValue;
    }

    return option;
}

function parseSurfaceAddress(value: unknown, source: string): BridgeSurfaceAddress {
    const record = requireRecord(value, source);
    const chatID = readOptionalString(record.chatID, `${source}.chatID`);
    const channelID = readOptionalString(record.channelID, `${source}.channelID`);
    const chatType = readOptionalString(record.chatType, `${source}.chatType`);

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
    if (chatType) {
        address.chatType = chatType;
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

function readOptionalArray(value: unknown, source: string): unknown[] {
    if (value === undefined) {
        return [];
    }

    return requireArray(value, source);
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

function requirePositiveInteger(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${source} must be a positive integer`);
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

function readOptionalBoolean(value: unknown, source: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throw new Error(`${source} must be a boolean`);
    }

    return value;
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
