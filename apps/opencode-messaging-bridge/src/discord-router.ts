import type { BridgeConfig } from "./config.js";
import {
    DISCORD_CHAT_INPUT_COMMAND,
    DISCORD_INTERACTION_APPLICATION_COMMAND,
    DISCORD_INTERACTION_PING,
    DISCORD_OPTION_STRING,
    DISCORD_OPTION_SUBCOMMAND,
    type DiscordInteraction,
    type DiscordInteractionOption,
    type DiscordMessage,
    type PongDiscordInteractionInput,
    type SendDiscordInteractionMessageInput,
    type SendDiscordMessageInput,
} from "./discord.js";
import type { OpenCodeHealth, OpenCodeSession } from "./opencode.js";
import {
    type BridgeBindingState,
    type BridgeState,
    type BridgeSurfaceAddress,
    type BridgeSurfaceState,
    loadOrCreateBridgeState,
    writeBridgeState,
} from "./state.js";

export interface DiscordRouterOpenCodeClient {
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number; directory?: string }): Promise<OpenCodeSession[]>;
    getSession(input: { sessionID: string; directory?: string }): Promise<OpenCodeSession>;
    createSession(input?: { title?: string; directory?: string }): Promise<OpenCodeSession>;
    sendPrompt(input: { sessionID: string; text: string; directory?: string }): Promise<void>;
    abortSession(input: { sessionID: string; directory?: string }): Promise<void>;
}

export interface DiscordRouterDiscordClient {
    sendMessage(input: SendDiscordMessageInput): Promise<void>;
    sendTyping(input: { channelID: string }): Promise<void>;
    sendInteractionMessage(input: SendDiscordInteractionMessageInput): Promise<void>;
    pongInteraction(input: PongDiscordInteractionInput): Promise<void>;
}

export interface DiscordBridgeRouterDependencies {
    config: BridgeConfig;
    opencode: DiscordRouterOpenCodeClient;
    discord: DiscordRouterDiscordClient;
    now?: () => Date;
}

interface ParsedDiscordCommand {
    name: string;
    args: string[];
    text: string;
}

export class DiscordBridgeRouter {
    private readonly config: BridgeConfig;
    private readonly opencode: DiscordRouterOpenCodeClient;
    private readonly discord: DiscordRouterDiscordClient;
    private readonly now: () => Date;

    constructor(dependencies: DiscordBridgeRouterDependencies) {
        this.config = dependencies.config;
        this.opencode = dependencies.opencode;
        this.discord = dependencies.discord;
        this.now = dependencies.now ?? (() => new Date());
    }

    async handleMessage(message: DiscordMessage): Promise<void> {
        if (message.authorBot || !message.userID || !this.isAllowedUser(message.userID)) {
            return;
        }
        if (!(await this.isAllowedChannel(message.channelID))) {
            return;
        }

        const command = parseDiscordMessageCommand(message.content, this.config.discord.prefix, this.config.implicitReply);
        if (!command) {
            return;
        }

        await this.handleCommand(message.channelID, command);
    }

    async handleInteraction(interaction: DiscordInteraction): Promise<void> {
        if (interaction.type === DISCORD_INTERACTION_PING) {
            await this.discord.pongInteraction({
                interactionID: interaction.id,
                interactionToken: interaction.token,
            });
            return;
        }
        if (interaction.type !== DISCORD_INTERACTION_APPLICATION_COMMAND) {
            return;
        }

        const command = parseDiscordSlashCommand(interaction, this.config.discord.slashCommand);
        if (!command) {
            return;
        }
        if (!interaction.userID || !this.isAllowedUser(interaction.userID)) {
            await this.respondInteraction(interaction, "This Discord user is not allowed to control OpenCode.", true);
            return;
        }
        if (!interaction.channelID || !(await this.isAllowedChannel(interaction.channelID))) {
            await this.respondInteraction(interaction, "Use this command in the configured OpenCode control channel.", true);
            return;
        }

        await this.respondInteraction(
            interaction,
            `Accepted /${this.config.discord.slashCommand} ${command.name}. Output will be posted in this channel.`,
            this.config.discord.slashResponsesEphemeral,
        );
        await this.handleCommand(interaction.channelID, command);
    }

    private async handleCommand(channelID: string, command: ParsedDiscordCommand): Promise<void> {
        if (command.name === "help") {
            await this.send(channelID, this.helpText());
            return;
        }
        if (command.name === "status") {
            await this.handleStatus(channelID);
            return;
        }
        if (command.name === "sessions") {
            await this.handleSessions(channelID);
            return;
        }
        if (command.name === "attach") {
            await this.handleAttach(channelID, command.args[0] || "latest");
            return;
        }
        if (command.name === "new") {
            await this.handleNew(channelID, command.text);
            return;
        }
        if (command.name === "prompt" || command.name === "reply") {
            await this.handlePrompt(channelID, command.text);
            return;
        }
        if (command.name === "abort") {
            await this.handleAbort(channelID);
            return;
        }

        await this.send(channelID, `[bridge] unknown command. Try ${this.config.discord.prefix} status, ${this.config.discord.prefix} sessions, ${this.config.discord.prefix} attach latest, ${this.config.discord.prefix} new, or ${this.config.discord.prefix} prompt.`);
    }

    private async handleStatus(channelID: string): Promise<void> {
        const [state, health] = await Promise.all([this.loadState(), this.opencode.health()]);
        const activeSessionID = findSurface(state, surfaceID(channelID))?.activeSessionID ?? null;

        await this.send(
            channelID,
            [
                `[bridge] OpenCode healthy: ${String(health.healthy)}`,
                `[bridge] OpenCode version: ${health.version}`,
                `[bridge] active session: ${activeSessionID ?? "none"}`,
            ].join("\n"),
        );
    }

    private async handleSessions(channelID: string): Promise<void> {
        const sessions = await this.opencode.listSessions({ limit: 10 });
        if (sessions.length === 0) {
            await this.send(channelID, "[bridge] no sessions found");
            return;
        }

        await this.send(channelID, sessions.map(formatSessionLine).join("\n"));
    }

    private async handleAttach(channelID: string, target: string): Promise<void> {
        const session = target === "latest" ? await this.latestSession() : await this.opencode.getSession({ sessionID: target });
        if (!session) {
            await this.send(channelID, "[bridge] no sessions found");
            return;
        }

        await this.bind(channelID, session);
        await this.send(channelID, `[bridge] attached ${formatSessionLine(session)}`);
    }

    private async handleNew(channelID: string, title: string): Promise<void> {
        const session = await this.opencode.createSession(title ? { title } : {});

        await this.bind(channelID, session);
        await this.send(channelID, `[bridge] created and attached ${formatSessionLine(session)}`);
    }

    private async handlePrompt(channelID: string, text: string): Promise<void> {
        if (text.length === 0) {
            await this.send(channelID, "[bridge] prompt text is required");
            return;
        }

        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(channelID));
        if (!surface?.activeSessionID) {
            await this.send(channelID, `[bridge] no active session. Use ${this.config.discord.prefix} attach latest or ${this.config.discord.prefix} new first.`);
            return;
        }

        await this.discord.sendTyping({ channelID });
        await this.opencode.sendPrompt({ sessionID: surface.activeSessionID, text });
        await this.send(channelID, `[bridge] prompt sent to ${surface.activeSessionID}`);
    }

    private async handleAbort(channelID: string): Promise<void> {
        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(channelID));
        if (!surface?.activeSessionID) {
            await this.send(channelID, `[bridge] no active session. Use ${this.config.discord.prefix} attach latest or ${this.config.discord.prefix} new first.`);
            return;
        }

        await this.opencode.abortSession({ sessionID: surface.activeSessionID });
        await this.send(channelID, `[bridge] abort requested for ${surface.activeSessionID}`);
    }

    private async latestSession(): Promise<OpenCodeSession | null> {
        const sessions = await this.opencode.listSessions({ limit: 1 });
        return sessions[0] ?? null;
    }

    private async bind(channelID: string, session: OpenCodeSession): Promise<void> {
        const state = await this.loadState();
        const timestamp = this.now().toISOString();
        const id = surfaceID(channelID);
        const address = surfaceAddress(channelID);

        upsertSurface(state, {
            id,
            platform: "discord",
            surface: address,
            activeSessionID: session.id,
            updatedAt: timestamp,
        });
        upsertBinding(state, {
            id: `${id}:${session.id}`,
            platform: "discord",
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

    private async send(channelID: string, content: string): Promise<void> {
        await this.discord.sendMessage({ channelID, content });
    }

    private async respondInteraction(interaction: DiscordInteraction, content: string, ephemeral: boolean): Promise<void> {
        await this.discord.sendInteractionMessage({
            interactionID: interaction.id,
            interactionToken: interaction.token,
            content,
            ephemeral,
        });
    }

    private async loadState(): Promise<BridgeState> {
        return loadOrCreateBridgeState(this.config.statePath, this.now());
    }

    private isAllowedUser(userID: string): boolean {
        return this.config.discord.allowedUserIDs.includes(userID);
    }

    private async isAllowedChannel(channelID: string): Promise<boolean> {
        if (channelID === this.config.discord.controlChannelID) {
            return true;
        }

        const state = await this.loadState();
        return state.surfaces.some((surface) => surface.platform === "discord" && surface.surface.channelID === channelID);
    }

    private helpText(): string {
        const prefix = this.config.discord.prefix;
        const slash = this.config.discord.slashCommand;

        return [
            "[bridge] Discord daemon commands",
            `- ${prefix} status or /${slash} status`,
            `- ${prefix} sessions or /${slash} sessions`,
            `- ${prefix} attach latest or /${slash} attach`,
            `- ${prefix} new <title> or /${slash} new`,
            `- ${prefix} prompt <text> or /${slash} prompt`,
            `- ${prefix} abort or /${slash} abort`,
            this.config.implicitReply ? "Plain messages from allowed users are sent to the active session." : "Plain messages are ignored; use the prefix or slash command.",
        ].join("\n");
    }
}

export function parseDiscordMessageCommand(content: string, prefix: string, implicitReply: boolean): ParsedDiscordCommand | null {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
        return implicitReply ? { name: "reply", args: [trimmed], text: trimmed } : null;
    }

    const rest = trimmed.slice(prefix.length).trim();
    if (rest.length === 0) {
        return { name: "help", args: [], text: "" };
    }

    const [name = "help", ...args] = rest.split(/\s+/);
    return {
        name: name.toLowerCase(),
        args,
        text: args.join(" ").trim(),
    };
}

export function parseDiscordSlashCommand(interaction: DiscordInteraction, commandName: string): ParsedDiscordCommand | null {
    const data = interaction.data;
    if (!data || data.type !== DISCORD_CHAT_INPUT_COMMAND || data.name !== commandName) {
        return null;
    }

    const selected = data.options.find((option) => option.type === DISCORD_OPTION_SUBCOMMAND);
    const name = selected?.name ?? "help";
    const options = selected?.options ?? [];

    if (name === "attach") {
        const target = optionValue(options, "session_id") || "latest";
        return { name, args: [target], text: target };
    }
    if (name === "new") {
        const title = optionValue(options, "title");
        return { name, args: title ? [title] : [], text: title };
    }
    if (name === "prompt" || name === "reply") {
        const text = optionValue(options, "text");
        return { name, args: text ? [text] : [], text };
    }

    return { name, args: [], text: "" };
}

function optionValue(options: DiscordInteractionOption[], name: string): string {
    const option = options.find((entry) => entry.name === name && entry.type === DISCORD_OPTION_STRING);
    if (option?.value === undefined) {
        return "";
    }

    return String(option.value).trim();
}

function surfaceID(channelID: string): string {
    return `discord:${channelID}`;
}

function surfaceAddress(channelID: string): BridgeSurfaceAddress {
    return {
        channelID,
        threadID: null,
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
