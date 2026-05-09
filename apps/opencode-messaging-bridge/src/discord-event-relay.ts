import type { SendDiscordMessageInput } from "./discord.js";
import {
    sessionErrorFromEvent,
    toolUpdateFromEvent,
    type OpenCodeSessionError,
    type OpenCodeToolUpdate,
} from "./event-summaries.js";
import type { OpenCodeEvent } from "./opencode.js";
import { permissionRequestFromEvent, type OpenCodePermissionRequest } from "./permissions.js";
import { type BridgeBindingState, loadOrCreateBridgeState } from "./state.js";

const DEFAULT_FLUSH_DELAY_MS = 1200;

export interface DiscordEventRelayDiscordClient {
    sendMessage(input: SendDiscordMessageInput): Promise<void>;
}

export interface DiscordEventRelayDependencies {
    statePath: string;
    discord: DiscordEventRelayDiscordClient;
    flushDelayMs?: number;
    setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface TextProgress {
    length: number;
}

interface StreamBuffer {
    sessionID: string;
    partID: string;
    text: string;
    timer: NodeJS.Timeout | null;
}

export class DiscordEventRelay {
    private readonly statePath: string;
    private readonly discord: DiscordEventRelayDiscordClient;
    private readonly flushDelayMs: number;
    private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
    private readonly clearTimer: (timer: NodeJS.Timeout) => void;
    private readonly progress = new Map<string, TextProgress>();
    private readonly buffers = new Map<string, StreamBuffer>();
    private readonly deliveredToolUpdates = new Set<string>();

    constructor(dependencies: DiscordEventRelayDependencies) {
        this.statePath = dependencies.statePath;
        this.discord = dependencies.discord;
        this.flushDelayMs = dependencies.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
        this.setTimer = dependencies.setTimer ?? setTimeout;
        this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    }

    async handleEvent(event: OpenCodeEvent): Promise<void> {
        const permission = permissionRequestFromEvent(event);
        if (permission) {
            await this.relayPermission(permission);
            return;
        }

        const sessionError = sessionErrorFromEvent(event);
        if (sessionError) {
            await this.relaySessionError(sessionError);
            return;
        }

        const toolUpdate = toolUpdateFromEvent(event);
        if (toolUpdate) {
            await this.relayToolUpdate(toolUpdate);
            return;
        }

        if (event.type === "message.part.updated") {
            this.handlePartUpdated(event);
            return;
        }

        if (event.type === "session.idle") {
            await this.flushSession(sessionIDFromEvent(event));
            return;
        }
    }

    async flushAll(): Promise<void> {
        const keys = [...this.buffers.keys()];
        for (const key of keys) {
            await this.flushBuffer(key);
        }
    }

    private handlePartUpdated(event: OpenCodeEvent): void {
        const part = readRecord(event.properties.part);
        if (!part || part.type !== "text" || part.ignored === true) {
            return;
        }

        const sessionID = readString(part.sessionID) ?? readString(part.sessionId) ?? sessionIDFromEvent(event);
        const partID = readString(part.id) ?? "part";
        if (!sessionID) {
            return;
        }

        this.bufferText(sessionID, partID, this.textDelta(sessionID, partID, part, event.properties));
    }

    private textDelta(
        sessionID: string,
        partID: string,
        part: Record<string, unknown>,
        properties: Record<string, unknown>,
    ): string {
        const key = `${sessionID}:${partID}:text`;
        const currentText = readString(part.text) ?? "";
        const explicitDelta = readString(properties.delta);
        if (explicitDelta !== null) {
            this.progress.set(key, { length: currentText.length });
            return explicitDelta;
        }

        const previousLength = this.progress.get(key)?.length ?? 0;
        this.progress.set(key, { length: currentText.length });
        if (currentText.length <= previousLength) {
            return "";
        }

        return currentText.slice(previousLength);
    }

    private bufferText(sessionID: string, partID: string, delta: string): void {
        if (!delta) {
            return;
        }

        const key = `${sessionID}:${partID}:text`;
        const buffer = this.buffers.get(key) ?? { sessionID, partID, text: "", timer: null };
        buffer.text += delta;
        if (!buffer.timer) {
            buffer.timer = this.setTimer(() => {
                void this.flushBuffer(key);
            }, this.flushDelayMs);
        }
        this.buffers.set(key, buffer);
    }

    private async flushSession(sessionID: string | null): Promise<void> {
        if (!sessionID) {
            return;
        }

        const keys = [...this.buffers.entries()]
            .filter(([, buffer]) => buffer.sessionID === sessionID)
            .map(([key]) => key);
        for (const key of keys) {
            await this.flushBuffer(key);
        }
    }

    private async flushBuffer(key: string): Promise<void> {
        const buffer = this.buffers.get(key);
        if (!buffer) {
            return;
        }

        this.buffers.delete(key);
        if (buffer.timer) {
            this.clearTimer(buffer.timer);
        }

        const text = buffer.text;
        if (!text.trim()) {
            return;
        }

        for (const binding of await this.discordBindings(buffer.sessionID)) {
            await this.send(binding, text);
        }
    }

    private async discordBindings(sessionID: string): Promise<BridgeBindingState[]> {
        const state = await loadOrCreateBridgeState(this.statePath);
        return state.bindings.filter((binding) => binding.platform === "discord" && binding.sessionID === sessionID);
    }

    private async relayPermission(permission: OpenCodePermissionRequest): Promise<void> {
        for (const binding of await this.discordBindings(permission.sessionID)) {
            await this.send(binding, formatDiscordPermission(permission));
        }
    }

    private async relayToolUpdate(update: OpenCodeToolUpdate): Promise<void> {
        if (this.deliveredToolUpdates.has(update.key)) {
            return;
        }

        this.deliveredToolUpdates.add(update.key);
        for (const binding of await this.discordBindings(update.sessionID)) {
            await this.send(binding, formatDiscordToolUpdate(update));
        }
    }

    private async relaySessionError(error: OpenCodeSessionError): Promise<void> {
        for (const binding of await this.discordBindings(error.sessionID)) {
            await this.send(binding, formatDiscordSessionError(error));
        }
    }

    private async send(binding: BridgeBindingState, content: string): Promise<void> {
        if (!binding.surface.channelID) {
            return;
        }

        await this.discord.sendMessage({
            channelID: binding.surface.channelID,
            content,
        });
    }
}

function formatDiscordToolUpdate(update: OpenCodeToolUpdate): string {
    return [
        `[bridge] ${toolStatusLabel(update.status)}: ${update.tool}`,
        `[bridge] detail: ${update.title}`,
    ].join("\n");
}

function formatDiscordSessionError(error: OpenCodeSessionError): string {
    return [
        "[bridge] session error",
        `[bridge] session: ${error.sessionID}`,
        `[bridge] error: ${error.message}`,
    ].join("\n");
}

function toolStatusLabel(status: OpenCodeToolUpdate["status"]): string {
    if (status === "running") {
        return "tool started";
    }
    if (status === "completed") {
        return "tool completed";
    }

    return "tool failed";
}

function formatDiscordPermission(permission: OpenCodePermissionRequest): string {
    const patternText = permission.patterns.length > 0 ? permission.patterns.join(", ") : "(none)";

    return [
        "[bridge] permission requested",
        `[bridge] id: ${permission.id}`,
        `[bridge] session: ${permission.sessionID}`,
        `[bridge] request: ${permission.title}`,
        `[bridge] permission: ${permission.permission}`,
        `[bridge] ${permission.patterns.length === 1 ? "pattern" : "patterns"}: ${patternText}`,
        `[bridge] reply: !oc allow ${permission.id}, !oc always ${permission.id}, or !oc deny ${permission.id}`,
    ].join("\n");
}

function sessionIDFromEvent(event: OpenCodeEvent): string | null {
    const direct = readString(event.properties.sessionID) ?? readString(event.properties.sessionId);
    if (direct) {
        return direct;
    }

    const info = readRecord(event.properties.info);
    const infoID = readString(info?.id) ?? readString(info?.sessionID) ?? readString(info?.sessionId);
    if (infoID) {
        return infoID;
    }

    const part = readRecord(event.properties.part);
    return readString(part?.sessionID) ?? readString(part?.sessionId);
}

function readRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}
