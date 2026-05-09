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
import {
    TELEGRAM_MARKDOWN_PARSE_MODE,
    chunkTelegramText,
    escapeTelegramMarkdown,
    type SendChatActionInput,
    type SendMessageInput,
    type SetMessageReactionInput,
    type TelegramMessage,
    type TelegramUpdate,
} from "./telegram.js";

const TELEGRAM_REACTION_DONE = "\u{1F44D}";
const TELEGRAM_REACTION_UNKNOWN = "\u{1F914}";
const TELEGRAM_DIRECT_COMMANDS = new Set(["status", "sessions", "attach", "new", "prompt", "reply", "abort"]);

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
    setMessageReaction(input: SetMessageReactionInput): Promise<void>;
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
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }

        if (command.name === "status") {
            await this.handleStatus(message);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "sessions") {
            await this.handleSessions(message);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "attach") {
            await this.handleAttach(message, command.args[0]);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "new") {
            await this.handleNew(message, command.args.join(" ").trim());
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "prompt" || command.name === "reply") {
            await this.handlePrompt(message, command.args.join(" ").trim());
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "abort") {
            await this.handleAbort(message);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }

        await this.send(message, bridgePlain("unknown command. Try /oc status, /oc sessions, /oc attach latest, /oc new, or /oc prompt."));
        await this.react(message, TELEGRAM_REACTION_UNKNOWN);
    }

    private async handleStatus(message: TelegramMessage): Promise<void> {
        const [state, health] = await Promise.all([this.loadState(), this.opencode.health()]);
        const activeSessionID = findSurface(state, surfaceID(message))?.activeSessionID ?? null;

        await this.send(
            message,
            [
                bridgeField("OpenCode healthy", String(health.healthy)),
                bridgeField("OpenCode version", health.version),
                bridgeField("active session", activeSessionID ?? "none"),
            ].join("\n"),
        );
    }

    private async handleSessions(message: TelegramMessage): Promise<void> {
        const sessions = await this.opencode.listSessions({ limit: 10 });
        if (sessions.length === 0) {
            await this.send(message, bridgePlain("no sessions found"));
            return;
        }

        await this.send(message, sessions.map(formatSessionLine).join("\n"));
    }

    private async handleAttach(message: TelegramMessage, target: string | undefined): Promise<void> {
        if (!target) {
            await this.send(message, bridgePlain("attach needs a session ID or latest"));
            return;
        }

        const session = target === "latest" ? await this.latestSession() : await this.opencode.getSession({ sessionID: target });
        if (!session) {
            await this.send(message, bridgePlain("no sessions found"));
            return;
        }

        await this.bind(message, session);
        await this.send(message, bridgeLine(`attached ${formatSessionLine(session)}`));
    }

    private async handleNew(message: TelegramMessage, title: string): Promise<void> {
        const session = await this.opencode.createSession(title ? { title } : {});

        await this.bind(message, session);
        await this.send(message, bridgeLine(`created and attached ${formatSessionLine(session)}`));
    }

    private async handlePrompt(message: TelegramMessage, text: string): Promise<void> {
        if (text.length === 0) {
            await this.send(message, bridgePlain("prompt text is required"));
            return;
        }

        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(message));
        if (!surface?.activeSessionID) {
            await this.send(message, bridgePlain("no active session. Use /oc attach latest or /oc new first."));
            return;
        }

        await this.telegram.sendChatAction({ chatID: message.chatID, threadID: message.threadID, action: "typing" });
        await this.opencode.sendPrompt({ sessionID: surface.activeSessionID, text });
        await this.send(message, bridgeLine(`prompt sent to ${markdownCode(surface.activeSessionID)}`));
    }

    private async handleAbort(message: TelegramMessage): Promise<void> {
        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(message));
        if (!surface?.activeSessionID) {
            await this.send(message, bridgePlain("no active session. Use /oc attach latest or /oc new first."));
            return;
        }

        await this.opencode.abortSession({ sessionID: surface.activeSessionID });
        await this.send(message, bridgeLine(`abort requested for ${markdownCode(surface.activeSessionID)}`));
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
            await this.telegram.sendMessage({
                chatID: message.chatID,
                threadID: message.threadID,
                text: chunk,
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            });
        }
    }

    private async react(message: TelegramMessage, emoji: string): Promise<void> {
        try {
            await this.telegram.setMessageReaction({ chatID: message.chatID, messageID: message.messageID, emoji });
        } catch {
            return;
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
    const root = parts[0] ? stripBotUsername(parts[0]) : null;
    if (root === "/oc") {
        return {
            name: parts[1]?.toLowerCase() ?? "status",
            args: parts.slice(2),
        };
    }
    if (!root?.startsWith("/")) {
        return null;
    }

    const directCommand = root.slice(1).toLowerCase();
    if (!TELEGRAM_DIRECT_COMMANDS.has(directCommand)) {
        return null;
    }

    return {
        name: directCommand,
        args: parts.slice(1),
    };
}

function stripBotUsername(command: string): string {
    return command.replace(/@\w+$/i, "").toLowerCase();
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
    return `${markdownCode(session.id)} ${escapeTelegramMarkdown(session.title ?? "(untitled)")}`;
}

function bridgePlain(text: string): string {
    return bridgeLine(escapeTelegramMarkdown(text));
}

function bridgeField(label: string, value: string): string {
    return bridgeLine(`${escapeTelegramMarkdown(label)}: ${markdownCode(value)}`);
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
