import type { BridgeConfig } from "./config.js";
import type { OpenCodeHealth, OpenCodeSession } from "./opencode.js";
import {
    type BridgeBindingState,
    type BridgeState,
    type BridgeSurfaceAddress,
    type BridgeSurfaceState,
    loadOrCreateBridgeState,
    writeBridgeState,
} from "./state.js";
import { chunkTelegramText, type SendChatActionInput, type SendMessageInput, type TelegramMessage, type TelegramUpdate } from "./telegram.js";

export interface TelegramRouterOpenCodeClient {
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number; directory?: string }): Promise<OpenCodeSession[]>;
    getSession(input: { sessionID: string; directory?: string }): Promise<OpenCodeSession>;
    createSession(input?: { title?: string; directory?: string }): Promise<OpenCodeSession>;
    sendPrompt(input: { sessionID: string; text: string; directory?: string }): Promise<void>;
    abortSession(input: { sessionID: string; directory?: string }): Promise<void>;
}

export interface TelegramRouterTelegramClient {
    sendMessage(input: SendMessageInput): Promise<void>;
    sendChatAction(input: SendChatActionInput): Promise<void>;
}

export interface TelegramBridgeRouterDependencies {
    config: BridgeConfig;
    opencode: TelegramRouterOpenCodeClient;
    telegram: TelegramRouterTelegramClient;
    now?: () => Date;
}

interface ParsedCommand {
    name: string;
    args: string[];
}

export class TelegramBridgeRouter {
    private readonly config: BridgeConfig;
    private readonly opencode: TelegramRouterOpenCodeClient;
    private readonly telegram: TelegramRouterTelegramClient;
    private readonly now: () => Date;

    constructor(dependencies: TelegramBridgeRouterDependencies) {
        this.config = dependencies.config;
        this.opencode = dependencies.opencode;
        this.telegram = dependencies.telegram;
        this.now = dependencies.now ?? (() => new Date());
    }

    async handleUpdate(update: TelegramUpdate): Promise<void> {
        const message = update.message;
        if (!message || !message.text || !this.isAllowed(message)) {
            return;
        }

        const command = parseCommand(message.text);
        if (!command) {
            if (!this.config.implicitReply) {
                return;
            }

            await this.handlePrompt(message, message.text);
            return;
        }

        if (command.name === "status") {
            await this.handleStatus(message);
            return;
        }
        if (command.name === "sessions") {
            await this.handleSessions(message);
            return;
        }
        if (command.name === "attach") {
            await this.handleAttach(message, command.args[0]);
            return;
        }
        if (command.name === "new") {
            await this.handleNew(message, command.args.join(" ").trim());
            return;
        }
        if (command.name === "prompt" || command.name === "reply") {
            await this.handlePrompt(message, command.args.join(" ").trim());
            return;
        }
        if (command.name === "abort") {
            await this.handleAbort(message);
            return;
        }

        await this.send(message, "[bridge] unknown command. Try /oc status, /oc sessions, /oc attach latest, /oc new, or /oc prompt.");
    }

    private async handleStatus(message: TelegramMessage): Promise<void> {
        const [state, health] = await Promise.all([this.loadState(), this.opencode.health()]);
        const activeSessionID = findSurface(state, surfaceID(message))?.activeSessionID ?? null;

        await this.send(
            message,
            [
                `[bridge] OpenCode healthy: ${String(health.healthy)}`,
                `[bridge] OpenCode version: ${health.version}`,
                `[bridge] active session: ${activeSessionID ?? "none"}`,
            ].join("\n"),
        );
    }

    private async handleSessions(message: TelegramMessage): Promise<void> {
        const sessions = await this.opencode.listSessions({ limit: 10 });
        if (sessions.length === 0) {
            await this.send(message, "[bridge] no sessions found");
            return;
        }

        await this.send(message, sessions.map(formatSessionLine).join("\n"));
    }

    private async handleAttach(message: TelegramMessage, target: string | undefined): Promise<void> {
        if (!target) {
            await this.send(message, "[bridge] attach needs a session ID or latest");
            return;
        }

        const session = target === "latest" ? await this.latestSession() : await this.opencode.getSession({ sessionID: target });
        if (!session) {
            await this.send(message, "[bridge] no sessions found");
            return;
        }

        await this.bind(message, session);
        await this.send(message, `[bridge] attached ${formatSessionLine(session)}`);
    }

    private async handleNew(message: TelegramMessage, title: string): Promise<void> {
        const session = await this.opencode.createSession(title ? { title } : {});

        await this.bind(message, session);
        await this.send(message, `[bridge] created and attached ${formatSessionLine(session)}`);
    }

    private async handlePrompt(message: TelegramMessage, text: string): Promise<void> {
        if (text.length === 0) {
            await this.send(message, "[bridge] prompt text is required");
            return;
        }

        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(message));
        if (!surface?.activeSessionID) {
            await this.send(message, "[bridge] no active session. Use /oc attach latest or /oc new first.");
            return;
        }

        await this.telegram.sendChatAction({ chatID: message.chatID, threadID: message.threadID, action: "typing" });
        await this.opencode.sendPrompt({ sessionID: surface.activeSessionID, text });
        await this.send(message, `[bridge] prompt sent to ${surface.activeSessionID}`);
    }

    private async handleAbort(message: TelegramMessage): Promise<void> {
        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(message));
        if (!surface?.activeSessionID) {
            await this.send(message, "[bridge] no active session. Use /oc attach latest or /oc new first.");
            return;
        }

        await this.opencode.abortSession({ sessionID: surface.activeSessionID });
        await this.send(message, `[bridge] abort requested for ${surface.activeSessionID}`);
    }

    private async latestSession(): Promise<OpenCodeSession | null> {
        const sessions = await this.opencode.listSessions({ limit: 1 });
        return sessions[0] ?? null;
    }

    private async bind(message: TelegramMessage, session: OpenCodeSession): Promise<void> {
        const state = await this.loadState();
        const timestamp = this.now().toISOString();
        const id = surfaceID(message);
        const address = surfaceAddress(message);

        upsertSurface(state, {
            id,
            platform: "telegram",
            surface: address,
            activeSessionID: session.id,
            updatedAt: timestamp,
        });
        upsertBinding(state, {
            id: `${id}:${session.id}`,
            platform: "telegram",
            surface: address,
            sessionID: session.id,
            directory: session.directory,
            title: session.title,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        state.updatedAt = timestamp;

        await writeBridgeState(this.config.statePath, state);
    }

    private async send(message: TelegramMessage, text: string): Promise<void> {
        for (const chunk of chunkTelegramText(text)) {
            await this.telegram.sendMessage({ chatID: message.chatID, threadID: message.threadID, text: chunk });
        }
    }

    private async loadState(): Promise<BridgeState> {
        return loadOrCreateBridgeState(this.config.statePath, this.now());
    }

    private isAllowed(message: TelegramMessage): boolean {
        if (!message.userID || !this.config.telegram.allowedUserIDs.includes(message.userID)) {
            return false;
        }
        if (this.config.telegram.allowedChatIDs.length === 0) {
            return true;
        }

        return this.config.telegram.allowedChatIDs.includes(message.chatID);
    }
}

function parseCommand(text: string): ParsedCommand | null {
    const parts = text.trim().split(/\s+/).filter((part) => part.length > 0);
    const root = parts[0];
    if (!root || !/^\/oc(?:@\w+)?$/i.test(root)) {
        return null;
    }

    return {
        name: parts[1]?.toLowerCase() ?? "status",
        args: parts.slice(2),
    };
}

function surfaceID(message: TelegramMessage): string {
    return `telegram:${message.chatID}:${message.threadID ?? ""}`;
}

function surfaceAddress(message: TelegramMessage): BridgeSurfaceAddress {
    return {
        chatID: message.chatID,
        threadID: message.threadID,
    };
}

function findSurface(state: BridgeState, id: string): BridgeSurfaceState | undefined {
    return state.surfaces.find((surface) => surface.id === id);
}

function upsertSurface(state: BridgeState, surface: BridgeSurfaceState): void {
    const index = state.surfaces.findIndex((entry) => entry.id === surface.id);
    if (index === -1) {
        state.surfaces.push(surface);
        return;
    }

    state.surfaces[index] = surface;
}

function upsertBinding(state: BridgeState, binding: BridgeBindingState): void {
    const index = state.bindings.findIndex((entry) => entry.id === binding.id);
    if (index === -1) {
        state.bindings.push(binding);
        return;
    }

    state.bindings[index] = binding;
}

function formatSessionLine(session: OpenCodeSession): string {
    return `${session.id}\t${session.title ?? "(untitled)"}`;
}
