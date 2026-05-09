import { sessionErrorFromEvent, toolUpdateFromEvent, type OpenCodeSessionError, type OpenCodeToolUpdate } from "./event-summaries.js";
import type { OpenCodeEvent } from "./opencode.js";
import { permissionRequestFromEvent, type OpenCodePermissionRequest } from "./permissions.js";
import { type BridgeBindingState, loadOrCreateBridgeState } from "./state.js";
import {
    TELEGRAM_MARKDOWN_PARSE_MODE,
    chunkTelegramText,
    escapeTelegramMarkdown,
    type EditMessageTextInput,
    type SendMessageDraftInput,
    type SendMessageInput,
    type TelegramSentMessage,
} from "./telegram.js";

const DEFAULT_FLUSH_DELAY_MS = 1200;
const TELEGRAM_PREVIEW_LIMIT = 4096;

export interface TelegramEventRelayTelegramClient {
    sendMessage(input: SendMessageInput): Promise<TelegramSentMessage>;
    sendMessageDraft(input: SendMessageDraftInput): Promise<void>;
    editMessageText(input: EditMessageTextInput): Promise<unknown>;
}

export interface TelegramEventRelayDependencies {
    statePath: string;
    telegram: TelegramEventRelayTelegramClient;
    flushDelayMs?: number;
    setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface StreamBuffer {
    sessionID: string;
    partID: string;
    text: string;
    timer: NodeJS.Timeout | null;
}

interface TelegramDeliveryPreview {
    draftID: number;
    messageID: number | null;
    text: string;
}

export class TelegramEventRelay {
    private readonly statePath: string;
    private readonly telegram: TelegramEventRelayTelegramClient;
    private readonly flushDelayMs: number;
    private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
    private readonly clearTimer: (timer: NodeJS.Timeout) => void;
    private readonly buffers = new Map<string, StreamBuffer>();
    private readonly previews = new Map<string, TelegramDeliveryPreview>();
    private readonly deliveredToolUpdates = new Set<string>();

    constructor(dependencies: TelegramEventRelayDependencies) {
        this.statePath = dependencies.statePath;
        this.telegram = dependencies.telegram;
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
            await this.flushPreview(key);
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

        this.bufferText(sessionID, partID, this.nextText(sessionID, partID, part, event.properties));
    }

    private nextText(
        sessionID: string,
        partID: string,
        part: Record<string, unknown>,
        properties: Record<string, unknown>,
    ): string | null {
        const key = `${sessionID}:${partID}:text`;
        const currentText = readString(part.text) ?? "";
        const explicitDelta = readString(properties.delta);
        const previousText = this.buffers.get(key)?.text ?? "";
        if (currentText.length > previousText.length) {
            return currentText;
        }
        if (explicitDelta !== null) {
            return `${previousText}${explicitDelta}`;
        }

        return null;
    }

    private bufferText(sessionID: string, partID: string, text: string | null): void {
        if (text === null || text.length === 0) {
            return;
        }

        const key = `${sessionID}:${partID}:text`;
        const buffer = this.buffers.get(key) ?? { sessionID, partID, text: "", timer: null };
        buffer.text = text;
        if (!buffer.timer) {
            buffer.timer = this.setTimer(() => {
                void this.flushPreview(key);
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
            await this.finaliseBuffer(key);
        }
    }

    private async flushPreview(key: string): Promise<void> {
        const buffer = this.buffers.get(key);
        if (!buffer) {
            return;
        }

        if (buffer.timer) {
            this.clearTimer(buffer.timer);
            buffer.timer = null;
        }

        const text = buffer.text;
        if (!text.trim()) {
            return;
        }

        for (const binding of await this.telegramBindings(buffer.sessionID)) {
            await this.updatePreview(key, binding, text);
        }
    }

    private async finaliseBuffer(key: string): Promise<void> {
        const buffer = this.buffers.get(key);
        if (!buffer) {
            return;
        }

        if (buffer.timer) {
            this.clearTimer(buffer.timer);
        }

        this.buffers.delete(key);
        const text = buffer.text;
        if (!text.trim()) {
            return;
        }

        const bindings = await this.telegramBindings(buffer.sessionID);
        for (const binding of bindings) {
            await this.finaliseDelivery(key, binding, text);
        }
    }

    private async telegramBindings(sessionID: string): Promise<BridgeBindingState[]> {
        const state = await loadOrCreateBridgeState(this.statePath);
        return state.bindings.filter((binding) => binding.platform === "telegram" && binding.sessionID === sessionID);
    }

    private async relayPermission(permission: OpenCodePermissionRequest): Promise<void> {
        for (const binding of await this.telegramBindings(permission.sessionID)) {
            await this.sendPermission(binding, permission);
        }
    }

    private async sendPermission(binding: BridgeBindingState, permission: OpenCodePermissionRequest): Promise<void> {
        if (!binding.surface.chatID) {
            return;
        }

        for (const chunk of chunkTelegramText(formatTelegramPermission(permission))) {
            await this.telegram.sendMessage({
                chatID: binding.surface.chatID,
                threadID: binding.surface.threadID,
                text: chunk,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
        }
    }

    private async relayToolUpdate(update: OpenCodeToolUpdate): Promise<void> {
        if (this.deliveredToolUpdates.has(update.key)) {
            return;
        }

        this.deliveredToolUpdates.add(update.key);
        for (const binding of await this.telegramBindings(update.sessionID)) {
            await this.sendToolUpdate(binding, update);
        }
    }

    private async sendToolUpdate(binding: BridgeBindingState, update: OpenCodeToolUpdate): Promise<void> {
        if (!binding.surface.chatID) {
            return;
        }

        for (const chunk of chunkTelegramText(formatTelegramToolUpdate(update))) {
            await this.telegram.sendMessage({
                chatID: binding.surface.chatID,
                threadID: binding.surface.threadID,
                text: chunk,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
        }
    }

    private async relaySessionError(error: OpenCodeSessionError): Promise<void> {
        for (const binding of await this.telegramBindings(error.sessionID)) {
            await this.sendSessionError(binding, error);
        }
    }

    private async sendSessionError(binding: BridgeBindingState, error: OpenCodeSessionError): Promise<void> {
        if (!binding.surface.chatID) {
            return;
        }

        for (const chunk of chunkTelegramText(formatTelegramSessionError(error))) {
            await this.telegram.sendMessage({
                chatID: binding.surface.chatID,
                threadID: binding.surface.threadID,
                text: chunk,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
        }
    }

    private async updatePreview(key: string, binding: BridgeBindingState, text: string): Promise<void> {
        if (!binding.surface.chatID) {
            return;
        }

        const escapedText = previewText(text);
        const deliveryKey = deliveryKeyForBinding(key, binding);
        const preview = this.previews.get(deliveryKey) ?? {
            draftID: draftIDForDelivery(deliveryKey),
            messageID: null,
            text: "",
        };
        if (preview.text === escapedText) {
            return;
        }

        if (binding.surface.chatType === "private") {
            await this.telegram.sendMessageDraft({
                chatID: binding.surface.chatID,
                threadID: binding.surface.threadID,
                draftID: preview.draftID,
                text: escapedText,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
            preview.text = escapedText;
            this.previews.set(deliveryKey, preview);
            return;
        }

        if (preview.messageID === null) {
            const sent = await this.telegram.sendMessage({
                chatID: binding.surface.chatID,
                threadID: binding.surface.threadID,
                text: escapedText,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
            preview.messageID = sent.messageID;
            preview.text = escapedText;
            this.previews.set(deliveryKey, preview);
            return;
        }

        await this.telegram.editMessageText({
            chatID: binding.surface.chatID,
            messageID: preview.messageID,
            text: escapedText,
            parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
        });
        preview.text = escapedText;
        this.previews.set(deliveryKey, preview);
    }

    private async finaliseDelivery(key: string, binding: BridgeBindingState, text: string): Promise<void> {
        if (!binding.surface.chatID) {
            return;
        }

        const deliveryKey = deliveryKeyForBinding(key, binding);
        const preview = this.previews.get(deliveryKey);
        const chunks = chunkTelegramText(text).map(escapeTelegramMarkdown);
        if (binding.surface.chatType === "private") {
            for (const chunk of chunks) {
                await this.telegram.sendMessage({
                    chatID: binding.surface.chatID,
                    threadID: binding.surface.threadID,
                    text: chunk,
                    parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
                });
            }
            this.previews.delete(deliveryKey);
            return;
        }

        const [firstChunk, ...remainingChunks] = chunks;
        if (!firstChunk) {
            return;
        }

        if (preview?.messageID !== null && preview?.messageID !== undefined) {
            if (preview.text !== firstChunk) {
                await this.telegram.editMessageText({
                    chatID: binding.surface.chatID,
                    messageID: preview.messageID,
                    text: firstChunk,
                    parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
                });
            }
        } else {
            await this.telegram.sendMessage({
                chatID: binding.surface.chatID,
                threadID: binding.surface.threadID,
                text: firstChunk,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
        }

        for (const chunk of remainingChunks) {
            await this.telegram.sendMessage({
                chatID: binding.surface.chatID,
                threadID: binding.surface.threadID,
                text: chunk,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
        }

        this.previews.delete(deliveryKey);
    }
}

function previewText(text: string): string {
    return escapeTelegramMarkdown(chunkTelegramText(text, TELEGRAM_PREVIEW_LIMIT)[0] ?? "");
}

function formatTelegramPermission(permission: OpenCodePermissionRequest): string {
    const patternText = permission.patterns.length > 0 ? permission.patterns.join(", ") : "(none)";

    return [
        bridgePlain("permission requested"),
        bridgeField("id", permission.id),
        bridgeField("session", permission.sessionID),
        bridgeTextField("request", permission.title),
        bridgeField("permission", permission.permission),
        bridgeField(permission.patterns.length === 1 ? "pattern" : "patterns", patternText),
        bridgeLine(`${escapeTelegramMarkdown("reply")}: ${markdownCode(`/oc allow ${permission.id}`)}, ${markdownCode(`/oc always ${permission.id}`)}, or ${markdownCode(`/oc deny ${permission.id}`)}`),
    ].join("\n");
}

function formatTelegramToolUpdate(update: OpenCodeToolUpdate): string {
    return [
        bridgeLine(`${escapeTelegramMarkdown(toolStatusLabel(update.status))}: ${markdownCode(update.tool)}`),
        bridgeTextField("detail", update.title),
    ].join("\n");
}

function formatTelegramSessionError(error: OpenCodeSessionError): string {
    return [
        bridgePlain("session error"),
        bridgeField("session", error.sessionID),
        bridgeTextField("error", error.message),
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

function bridgePlain(text: string): string {
    return bridgeLine(escapeTelegramMarkdown(text));
}

function bridgeField(label: string, value: string): string {
    return bridgeLine(`${escapeTelegramMarkdown(label)}: ${markdownCode(value)}`);
}

function bridgeTextField(label: string, value: string): string {
    return bridgeLine(`${escapeTelegramMarkdown(label)}: ${escapeTelegramMarkdown(value)}`);
}

function bridgeLine(text: string): string {
    return `${markdownBold("[bridge]")} ${text}`;
}

function markdownBold(text: string): string {
    return `*${escapeTelegramMarkdown(text)}*`;
}

function markdownCode(text: string): string {
    return `\`${text.replace(/[\\`]/g, (character) => `\\${character}`)}\``;
}

function deliveryKeyForBinding(streamKey: string, binding: BridgeBindingState): string {
    return `${streamKey}:${binding.surface.chatID ?? ""}:${binding.surface.threadID ?? ""}`;
}

function draftIDForDelivery(key: string): number {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0) % 2147483647 || 1;
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
