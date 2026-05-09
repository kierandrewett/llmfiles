import type { BridgeConfig } from "./config.js";
import {
    type DiscordGatewayBotInfo,
    type DiscordInteraction,
    type DiscordMessage,
    type RegisterDiscordSlashCommandInput,
    discordSlashCommandSignature,
    parseDiscordInteraction,
    parseDiscordMessage,
} from "./discord.js";
import { loadOrCreateBridgeState, type BridgeState, writeBridgeState } from "./state.js";

const DISCORD_GATEWAY_VERSION = "10";
const DISCORD_GATEWAY_ENCODING = "json";
const GATEWAY_OPEN_STATE = 1;
const GATEWAY_CLOSE_RECONNECT = 4000;
const GATEWAY_INTENT_GUILDS = 1 << 0;
const GATEWAY_INTENT_GUILD_MESSAGES = 1 << 9;
const GATEWAY_INTENT_DIRECT_MESSAGES = 1 << 12;
const GATEWAY_INTENT_MESSAGE_CONTENT = 1 << 15;
const DISCORD_BRIDGE_LIBRARY_NAME = "opencode-messaging-bridge";
const DISCORD_REGISTRATION_RECORD_TYPE = "discord.slash-command-registration";

export interface DiscordGatewayApiClient {
    getGatewayBot(): Promise<DiscordGatewayBotInfo>;
    registerSlashCommand(input: RegisterDiscordSlashCommandInput): Promise<void>;
}

export interface DiscordGatewayRouter {
    handleMessage(message: DiscordMessage): Promise<void>;
    handleInteraction(interaction: DiscordInteraction): Promise<void>;
}

export interface DiscordGatewaySocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
    addEventListener(type: "error", listener: (event: { error?: unknown }) => void): void;
}

export type CreateDiscordGatewaySocket = (url: string) => DiscordGatewaySocket;

export interface DiscordGatewayRunnerDependencies {
    config: BridgeConfig;
    discord: DiscordGatewayApiClient;
    router: DiscordGatewayRouter;
    createSocket?: CreateDiscordGatewaySocket;
    now?: () => Date;
    random?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    setIntervalTimer?: typeof setInterval;
    clearIntervalTimer?: typeof clearInterval;
}

interface DiscordGatewayPayload {
    op: number;
    d: unknown;
    s: number | null;
    t: string | null;
}

interface HeartbeatState {
    timeout: ReturnType<typeof setTimeout> | null;
    interval: ReturnType<typeof setInterval> | null;
    acked: boolean;
}

export class DiscordGatewayRunner {
    private readonly config: BridgeConfig;
    private readonly discord: DiscordGatewayApiClient;
    private readonly router: DiscordGatewayRouter;
    private readonly createSocket: CreateDiscordGatewaySocket;
    private readonly now: () => Date;
    private readonly random: () => number;
    private readonly setTimer: typeof setTimeout;
    private readonly clearTimer: typeof clearTimeout;
    private readonly setIntervalTimer: typeof setInterval;
    private readonly clearIntervalTimer: typeof clearInterval;
    private readonly heartbeat: HeartbeatState = { timeout: null, interval: null, acked: true };
    private activeSocket: DiscordGatewaySocket | null = null;

    constructor(dependencies: DiscordGatewayRunnerDependencies) {
        this.config = dependencies.config;
        this.discord = dependencies.discord;
        this.router = dependencies.router;
        this.createSocket = dependencies.createSocket ?? createDefaultSocket;
        this.now = dependencies.now ?? (() => new Date());
        this.random = dependencies.random ?? Math.random;
        this.setTimer = dependencies.setTimer ?? setTimeout;
        this.clearTimer = dependencies.clearTimer ?? clearTimeout;
        this.setIntervalTimer = dependencies.setIntervalTimer ?? setInterval;
        this.clearIntervalTimer = dependencies.clearIntervalTimer ?? clearInterval;
    }

    async runOnce(): Promise<number> {
        const url = await this.gatewayUrl();
        const socket = this.createSocket(url);
        this.activeSocket = socket;
        let processed = 0;

        return await new Promise<number>((resolve, reject) => {
            let settled = false;
            const finish = (result: { value: number } | { error: unknown }): void => {
                if (settled) {
                    return;
                }
                settled = true;
                this.clearHeartbeat();
                this.activeSocket = null;
                if ("error" in result) {
                    reject(result.error);
                    return;
                }

                resolve(result.value);
            };

            socket.addEventListener("message", (event) => {
                void (async () => {
                    try {
                        const payload = parseGatewayPayload(await socketDataToText(event.data));
                        processed += await this.handlePayload(payload);
                    } catch (error) {
                        finish({ error });
                    }
                })();
            });
            socket.addEventListener("close", () => {
                finish({ value: processed });
            });
            socket.addEventListener("error", (event) => {
                finish({ error: event.error ?? new Error("Discord gateway socket error") });
            });
        });
    }

    private async gatewayUrl(): Promise<string> {
        const state = await loadOrCreateBridgeState(this.config.statePath, this.now());
        if (
            state.platforms.discord.gatewaySessionID
            && state.platforms.discord.resumeGatewayUrl
            && state.platforms.discord.sequence !== null
        ) {
            return gatewayUrlWithQuery(state.platforms.discord.resumeGatewayUrl);
        }

        const gateway = await this.discord.getGatewayBot();
        return gatewayUrlWithQuery(gateway.url);
    }

    private async handlePayload(payload: DiscordGatewayPayload): Promise<number> {
        if (payload.s !== null) {
            await this.persistGatewayState({ sequence: payload.s });
        }

        if (payload.op === 10) {
            const data = requireRecord(payload.d, "Discord gateway hello payload.d");
            const interval = requireNumber(data.heartbeat_interval, "Discord gateway hello payload.d.heartbeat_interval");
            this.startHeartbeat(interval);
            if (!(await this.resumeGateway())) {
                this.identifyGateway();
            }
            return 0;
        }
        if (payload.op === 11) {
            this.heartbeat.acked = true;
            return 0;
        }
        if (payload.op === 7) {
            this.activeSocket?.close(GATEWAY_CLOSE_RECONNECT, "discord reconnect requested");
            return 0;
        }
        if (payload.op === 9) {
            if (payload.d !== true) {
                await this.persistGatewayState({ gatewaySessionID: null, resumeGatewayUrl: null, sequence: null });
            }
            this.activeSocket?.close(GATEWAY_CLOSE_RECONNECT, "discord invalid session");
            return 0;
        }
        if (payload.op !== 0) {
            return 0;
        }

        await this.handleDispatch(payload);
        return 1;
    }

    private async handleDispatch(payload: DiscordGatewayPayload): Promise<void> {
        if (payload.t === "READY") {
            const data = requireRecord(payload.d, "Discord READY payload.d");
            const application = readRecord(data.application, "Discord READY payload.d.application");
            const applicationID = this.config.discord.applicationID ?? readString(application?.id, "Discord READY payload.d.application.id");

            await this.persistGatewayState({
                gatewaySessionID: readString(data.session_id, "Discord READY payload.d.session_id"),
                resumeGatewayUrl: readString(data.resume_gateway_url, "Discord READY payload.d.resume_gateway_url"),
            });
            if (applicationID) {
                await this.registerSlashCommandOnce(applicationID);
            }
            return;
        }
        if (payload.t === "MESSAGE_CREATE") {
            await this.router.handleMessage(parseDiscordMessage(payload.d, "Discord MESSAGE_CREATE payload.d"));
            return;
        }
        if (payload.t === "INTERACTION_CREATE") {
            await this.router.handleInteraction(parseDiscordInteraction(payload.d, "Discord INTERACTION_CREATE payload.d"));
        }
    }

    private identifyGateway(): void {
        this.sendGateway({
            op: 2,
            d: {
                token: this.requireBotToken(),
                intents: discordGatewayIntents(this.config),
                properties: {
                    os: process.platform,
                    browser: DISCORD_BRIDGE_LIBRARY_NAME,
                    device: DISCORD_BRIDGE_LIBRARY_NAME,
                },
            },
        });
    }

    private async resumeGateway(): Promise<boolean> {
        const state = await loadOrCreateBridgeState(this.config.statePath, this.now());
        const sessionID = state.platforms.discord.gatewaySessionID;
        const sequence = state.platforms.discord.sequence;
        if (!sessionID || sequence === null) {
            return false;
        }

        this.sendGateway({
            op: 6,
            d: {
                token: this.requireBotToken(),
                session_id: sessionID,
                seq: sequence,
            },
        });
        return true;
    }

    private startHeartbeat(intervalMs: number): void {
        this.clearHeartbeat();
        this.heartbeat.acked = true;
        const firstDelay = Math.max(0, Math.floor(intervalMs * this.random()));
        this.heartbeat.timeout = this.setTimer(() => {
            this.sendHeartbeat();
            this.heartbeat.interval = this.setIntervalTimer(() => {
                this.sendHeartbeat();
            }, intervalMs);
        }, firstDelay);
    }

    private sendHeartbeat(): void {
        if (!this.heartbeat.acked) {
            this.activeSocket?.close(GATEWAY_CLOSE_RECONNECT, "discord heartbeat ack timeout");
            return;
        }

        this.heartbeat.acked = false;
        void loadOrCreateBridgeState(this.config.statePath, this.now()).then((state) => {
            this.sendGateway({ op: 1, d: state.platforms.discord.sequence });
        });
    }

    private clearHeartbeat(): void {
        if (this.heartbeat.timeout) {
            this.clearTimer(this.heartbeat.timeout);
        }
        if (this.heartbeat.interval) {
            this.clearIntervalTimer(this.heartbeat.interval);
        }
        this.heartbeat.timeout = null;
        this.heartbeat.interval = null;
        this.heartbeat.acked = true;
    }

    private sendGateway(payload: { op: number; d: unknown }): void {
        if (!this.activeSocket || this.activeSocket.readyState !== GATEWAY_OPEN_STATE) {
            return;
        }

        this.activeSocket.send(JSON.stringify(payload));
    }

    private async persistGatewayState(patch: Partial<BridgeState["platforms"]["discord"]>): Promise<void> {
        const state = await loadOrCreateBridgeState(this.config.statePath, this.now());
        state.platforms.discord = {
            ...state.platforms.discord,
            ...patch,
        };
        state.updatedAt = this.now().toISOString();
        await writeBridgeState(this.config.statePath, state);
    }

    private async registerSlashCommandOnce(applicationID: string): Promise<void> {
        if (!this.config.discord.registerSlashCommands) {
            return;
        }

        const key = registrationKey(applicationID, this.config.discord.guildID, this.config.discord.slashCommand);
        const signature = discordSlashCommandSignature(this.config.discord.slashCommand);
        const state = await loadOrCreateBridgeState(this.config.statePath, this.now());
        if (hasRegistrationSignature(state, key, signature)) {
            return;
        }

        await this.discord.registerSlashCommand({
            applicationID,
            guildID: this.config.discord.guildID,
            name: this.config.discord.slashCommand,
        });

        upsertRegistrationSignature(state, key, signature);
        state.updatedAt = this.now().toISOString();
        await writeBridgeState(this.config.statePath, state);
    }

    private requireBotToken(): string {
        if (!this.config.discord.botToken) {
            throw new Error("Discord bridge is not enabled. Set OPENCODE_BRIDGE_DISCORD_BOT_TOKEN, OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID, and OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS.");
        }

        return this.config.discord.botToken;
    }
}

export function discordGatewayIntents(config: BridgeConfig): number {
    let intents = GATEWAY_INTENT_GUILDS | GATEWAY_INTENT_GUILD_MESSAGES | GATEWAY_INTENT_DIRECT_MESSAGES;
    if (config.discord.messageContentIntent) {
        intents |= GATEWAY_INTENT_MESSAGE_CONTENT;
    }

    return intents;
}

function createDefaultSocket(url: string): DiscordGatewaySocket {
    return new DefaultDiscordGatewaySocket(url);
}

class DefaultDiscordGatewaySocket implements DiscordGatewaySocket {
    private readonly socket: WebSocket;

    constructor(url: string) {
        this.socket = new WebSocket(url);
    }

    get readyState(): number {
        return this.socket.readyState;
    }

    send(data: string): void {
        this.socket.send(data);
    }

    close(code?: number, reason?: string): void {
        this.socket.close(code, reason);
    }

    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
    addEventListener(type: "error", listener: (event: { error?: unknown }) => void): void;
    addEventListener(
        type: "message" | "close" | "error",
        listener: ((event: { data: unknown }) => void) | ((event: { code: number; reason: string }) => void) | ((event: { error?: unknown }) => void),
    ): void {
        if (type === "message") {
            const messageListener = listener as (event: { data: unknown }) => void;
            this.socket.addEventListener("message", (event) => {
                messageListener({ data: event.data });
            });
            return;
        }
        if (type === "close") {
            const closeListener = listener as (event: { code: number; reason: string }) => void;
            this.socket.addEventListener("close", (event) => {
                closeListener({ code: event.code, reason: event.reason });
            });
            return;
        }

        const errorListener = listener as (event: { error?: unknown }) => void;
        this.socket.addEventListener("error", () => {
            errorListener({ error: new Error("Discord gateway socket error") });
        });
    }
}

function gatewayUrlWithQuery(value: string): string {
    const url = new URL(value);
    url.searchParams.set("v", DISCORD_GATEWAY_VERSION);
    url.searchParams.set("encoding", DISCORD_GATEWAY_ENCODING);

    return url.toString();
}

function parseGatewayPayload(text: string): DiscordGatewayPayload {
    const record = requireRecord(JSON.parse(text) as unknown, "Discord gateway payload");

    return {
        op: requireNumber(record.op, "Discord gateway payload.op"),
        d: record.d,
        s: record.s === undefined || record.s === null ? null : requireNumber(record.s, "Discord gateway payload.s"),
        t: record.t === undefined || record.t === null ? null : requireString(record.t, "Discord gateway payload.t"),
    };
}

async function socketDataToText(data: unknown): Promise<string> {
    if (typeof data === "string") {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(data);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
        return await data.text();
    }

    throw new Error("Discord gateway message data must be text, ArrayBuffer, or Blob");
}

function registrationKey(applicationID: string, guildID: string | null, commandName: string): string {
    return `${applicationID}:${guildID ?? "global"}:${commandName}`;
}

function hasRegistrationSignature(state: BridgeState, key: string, signature: string): boolean {
    return state.deliveries.some((delivery) => (
        delivery.type === DISCORD_REGISTRATION_RECORD_TYPE
        && delivery.key === key
        && delivery.signature === signature
    ));
}

function upsertRegistrationSignature(state: BridgeState, key: string, signature: string): void {
    const record = {
        type: DISCORD_REGISTRATION_RECORD_TYPE,
        key,
        signature,
    };
    const index = state.deliveries.findIndex((delivery) => delivery.type === DISCORD_REGISTRATION_RECORD_TYPE && delivery.key === key);
    if (index === -1) {
        state.deliveries.push(record);
        return;
    }

    state.deliveries[index] = record;
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`${source} must be an object`);
    }

    return value;
}

function readRecord(value: unknown, source: string): Record<string, unknown> | null {
    if (value === undefined || value === null) {
        return null;
    }

    return requireRecord(value, source);
}

function requireString(value: unknown, source: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${source} must be a non-empty string`);
    }

    return value;
}

function readString(value: unknown, source: string): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    return requireString(value, source);
}

function requireNumber(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${source} must be a finite number`);
    }

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
