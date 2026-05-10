import {
    createScheduledJobID,
    formatScheduleInterval,
    nextScheduledRun,
    parseScheduleArgs,
    recordScheduledJobRun,
    scheduleErrorMessage,
} from "./automation.js";
import type { BridgeConfig } from "./config.js";
import {
    DISCORD_CHAT_INPUT_COMMAND,
    DISCORD_COMPONENT_ACTION_ROW,
    DISCORD_COMPONENT_STRING_SELECT,
    DISCORD_INTERACTION_APPLICATION_COMMAND,
    DISCORD_INTERACTION_MESSAGE_COMPONENT,
    DISCORD_INTERACTION_PING,
    DISCORD_OPTION_STRING,
    DISCORD_OPTION_SUBCOMMAND,
    type DiscordAttachment,
    type DiscordInteraction,
    type DiscordMessageComponent,
    type DiscordInteractionOption,
    type DiscordMessage,
    type PongDiscordInteractionInput,
    type SendDiscordInteractionMessageInput,
    type SendDiscordMessageInput,
} from "./discord.js";
import type { IntentResolverOutput, IntentResolverReadyOutput } from "./intent-resolver.js";
import type { OpenCodeHealth, OpenCodePermissionResponse, OpenCodeSession } from "./opencode.js";
import {
    type BridgeBindingState,
    type BridgeIntentResolverState,
    type BridgeScheduledJobState,
    type BridgeState,
    type BridgeSurfaceAddress,
    type BridgeSurfaceState,
    loadOrCreateBridgeState,
    writeBridgeState,
} from "./state.js";
import {
    audioFormatFromMetadata,
    downloadRemoteAudio,
    enforceAudioSizeLimit,
    type OpenRouterAudioFormat,
    type TranscriptionResult,
} from "./voice.js";

const DISCORD_INTENT_COMPONENT_PREFIX = "ir";
const DISCORD_SELECT_PLACEHOLDER = "Choose an answer";
const DISCORD_SELECT_LABEL_LIMIT = 100;

export interface DiscordRouterOpenCodeClient {
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number; directory?: string }): Promise<OpenCodeSession[]>;
    getSession(input: { sessionID: string; directory?: string }): Promise<OpenCodeSession>;
    createSession(input?: { title?: string; directory?: string }): Promise<OpenCodeSession>;
    sendPrompt(input: { sessionID: string; text: string; directory?: string }): Promise<void>;
    abortSession(input: { sessionID: string; directory?: string }): Promise<void>;
    replyPermission(input: { sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string; directory?: string }): Promise<void>;
}

export interface DiscordRouterDiscordClient {
    sendMessage(input: SendDiscordMessageInput): Promise<void>;
    sendTyping(input: { channelID: string }): Promise<void>;
    sendInteractionMessage(input: SendDiscordInteractionMessageInput): Promise<void>;
    pongInteraction(input: PongDiscordInteractionInput): Promise<void>;
}

export interface DiscordVoiceTranscriber {
    transcribe(input: { data: Uint8Array; format: OpenRouterAudioFormat }): Promise<TranscriptionResult>;
}

export interface DiscordIntentResolverRunResult {
    resolverSessionID: string;
    output: IntentResolverOutput;
}

export interface DiscordIntentResolver {
    start(input: { text: string; workspaceRoot: string }): Promise<DiscordIntentResolverRunResult>;
    continue(input: { resolverSessionID: string; answer: string; workspaceRoot: string }): Promise<DiscordIntentResolverRunResult>;
}

export interface DiscordBridgeRouterDependencies {
    config: BridgeConfig;
    opencode: DiscordRouterOpenCodeClient;
    discord: DiscordRouterDiscordClient;
    intentResolver?: DiscordIntentResolver;
    transcriber?: DiscordVoiceTranscriber;
    fetch?: typeof fetch;
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
    private readonly intentResolver: DiscordIntentResolver | null;
    private readonly transcriber: DiscordVoiceTranscriber | null;
    private readonly fetcher: typeof fetch;
    private readonly now: () => Date;

    constructor(dependencies: DiscordBridgeRouterDependencies) {
        this.config = dependencies.config;
        this.opencode = dependencies.opencode;
        this.discord = dependencies.discord;
        this.intentResolver = dependencies.intentResolver ?? null;
        this.transcriber = dependencies.transcriber ?? null;
        this.fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
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
        if (command) {
            await this.handleCommand(message.channelID, command);
            return;
        }

        if (message.content.trim().length > 0) {
            if (await this.handlePendingResolverText(message.channelID, message.userID, message.content.trim())) {
                return;
            }
            if (this.config.intentResolver.enabled) {
                await this.handleIntentResolverStart(message.channelID, message.userID, message.content.trim());
                return;
            }
        }

        const attachment = firstAudioAttachment(message.attachments ?? []);
        if (attachment) {
            await this.handleAudioPrompt(message.channelID, attachment);
        }
    }

    async handleInteraction(interaction: DiscordInteraction): Promise<void> {
        if (interaction.type === DISCORD_INTERACTION_PING) {
            await this.discord.pongInteraction({
                interactionID: interaction.id,
                interactionToken: interaction.token,
            });
            return;
        }
        if (interaction.type === DISCORD_INTERACTION_MESSAGE_COMPONENT) {
            await this.handleComponentInteraction(interaction);
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
        if (command.name === "jobs") {
            await this.handleJobs(channelID);
            return;
        }
        if (command.name === "schedule") {
            await this.handleSchedule(channelID, command.args);
            return;
        }
        if (command.name === "unschedule") {
            await this.handleUnschedule(channelID, command.args[0]);
            return;
        }
        if (command.name === "run-now") {
            await this.handleRunNow(channelID, command.args[0]);
            return;
        }
        if (command.name === "allow" || command.name === "always" || command.name === "deny") {
            await this.handlePermissionReply(channelID, command.name, command.args);
            return;
        }

        await this.send(channelID, `[bridge] unknown command. Try ${this.config.discord.prefix} status, ${this.config.discord.prefix} sessions, ${this.config.discord.prefix} attach latest, ${this.config.discord.prefix} new, ${this.config.discord.prefix} prompt, ${this.config.discord.prefix} schedule, or ${this.config.discord.prefix} allow.`);
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

    private async handleAudioPrompt(channelID: string, attachment: DiscordAttachment): Promise<void> {
        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(channelID));
        if (!surface?.activeSessionID) {
            await this.send(channelID, `[bridge] no active session. Use ${this.config.discord.prefix} attach latest or ${this.config.discord.prefix} new first.`);
            return;
        }
        if (!this.config.voice.enabled || this.transcriber === null) {
            await this.send(channelID, "[bridge] voice transcription is disabled");
            return;
        }

        const format = audioFormatFromMetadata({ mimeType: attachment.contentType, fileName: attachment.filename });
        if (format === null) {
            await this.send(channelID, "[bridge] unsupported audio format. Use wav, mp3, flac, m4a, ogg, webm, or aac.");
            return;
        }

        await this.discord.sendTyping({ channelID });
        try {
            enforceAudioSizeLimit(attachment.size, this.config.voice.maxAudioBytes);
            const audio = await downloadRemoteAudio({
                url: attachment.url,
                maxBytes: this.config.voice.maxAudioBytes,
                fetch: this.fetcher,
            });
            const transcription = await this.transcriber.transcribe({ data: audio, format });
            const text = transcription.text.trim();
            if (text.length === 0) {
                await this.send(channelID, "[bridge] audio transcription was empty");
                return;
            }

            await this.opencode.sendPrompt({ sessionID: surface.activeSessionID, text });
            await this.send(channelID, `[bridge] transcribed audio sent to ${surface.activeSessionID}`);
        } catch (error) {
            await this.send(channelID, `[bridge] audio transcription failed: ${audioErrorMessage(error)}`);
        }
    }

    private async handleComponentInteraction(interaction: DiscordInteraction): Promise<void> {
        if (!interaction.userID || !this.isAllowedUser(interaction.userID)) {
            await this.respondInteraction(interaction, "This Discord user is not allowed to control OpenCode.", true);
            return;
        }
        if (!interaction.channelID || !(await this.isAllowedChannel(interaction.channelID))) {
            await this.respondInteraction(interaction, "Use this component in the configured OpenCode control channel.", true);
            return;
        }

        const parsed = parseIntentComponentData(interaction.data);
        if (!parsed) {
            await this.respondInteraction(interaction, "Unknown action", true);
            return;
        }

        const state = await this.loadState();
        const pending = state.intentResolvers.find((entry) => entry.id === parsed.resolverID);
        if (!pending || pending.platform !== "discord" || pending.surfaceID !== surfaceID(interaction.channelID) || pending.userID !== interaction.userID) {
            await this.respondInteraction(interaction, "That clarification expired", true);
            return;
        }
        if (resolverExpired(pending, this.now())) {
            removeIntentResolver(state, pending.id);
            state.updatedAt = this.now().toISOString();
            await writeBridgeState(this.config.statePath, state);
            await this.respondInteraction(interaction, "That clarification expired", true);
            return;
        }

        const option = pending.options[parsed.optionIndex];
        if (!option) {
            await this.respondInteraction(interaction, "That option is no longer available", true);
            return;
        }

        await this.respondInteraction(interaction, "Working on it", true);
        await this.continueIntentResolver({
            channelID: interaction.channelID,
            userID: interaction.userID,
            pending,
            answer: option.value ?? option.label,
        });
    }

    private async handlePendingResolverText(channelID: string, userID: string, text: string): Promise<boolean> {
        const state = await this.loadState();
        const pending = findPendingIntentResolver(state, "discord", surfaceID(channelID), userID);
        if (!pending) {
            return false;
        }
        if (resolverExpired(pending, this.now())) {
            removeIntentResolver(state, pending.id);
            state.updatedAt = this.now().toISOString();
            await writeBridgeState(this.config.statePath, state);
            await this.send(channelID, "[bridge] that clarification expired. Send the intent again to restart.");
            return true;
        }
        if (!pending.allowFreeText) {
            await this.send(channelID, "[bridge] use the select menu for this clarification.");
            return true;
        }

        await this.continueIntentResolver({ channelID, userID, pending, answer: text });
        return true;
    }

    private async handleIntentResolverStart(channelID: string, userID: string, text: string): Promise<void> {
        const resolver = this.intentResolver;
        const workspaceRoot = this.config.workspace.root;
        if (!resolver || workspaceRoot === null) {
            await this.send(channelID, "[bridge] intent resolver is not configured");
            return;
        }

        await this.discord.sendTyping({ channelID });
        const result = await resolver.start({ text, workspaceRoot });
        await this.handleIntentResolverOutput({
            channelID,
            userID,
            resolverSessionID: result.resolverSessionID,
            output: result.output,
            workspaceRoot,
            originalText: text,
            pending: null,
        });
    }

    private async continueIntentResolver(input: { channelID: string; userID: string; pending: BridgeIntentResolverState; answer: string }): Promise<void> {
        const resolver = this.intentResolver;
        if (!resolver) {
            await this.send(input.channelID, "[bridge] intent resolver is not configured");
            return;
        }

        await this.discord.sendTyping({ channelID: input.channelID });
        const result = await resolver.continue({
            resolverSessionID: input.pending.resolverSessionID,
            answer: input.answer,
            workspaceRoot: input.pending.workspaceRoot,
        });
        await this.handleIntentResolverOutput({
            channelID: input.channelID,
            userID: input.userID,
            resolverSessionID: result.resolverSessionID,
            output: result.output,
            workspaceRoot: input.pending.workspaceRoot,
            originalText: input.pending.originalText,
            pending: input.pending,
        });
    }

    private async handleIntentResolverOutput(input: {
        channelID: string;
        userID: string;
        resolverSessionID: string;
        output: IntentResolverOutput;
        workspaceRoot: string;
        originalText: string;
        pending: BridgeIntentResolverState | null;
    }): Promise<void> {
        const output = input.output;
        if (output.status === "needs_clarification") {
            await this.storeAndSendClarification({ ...input, output });
            return;
        }
        if (output.status === "cannot_resolve") {
            if (input.pending) {
                await this.removePendingResolver(input.pending.id);
            }
            await this.send(input.channelID, `[bridge] could not resolve intent: ${output.reason}`);
            return;
        }

        if (input.pending) {
            await this.removePendingResolver(input.pending.id);
        }
        await this.startResolvedIntentSession(input.channelID, output);
    }

    private async storeAndSendClarification(input: {
        channelID: string;
        userID: string;
        resolverSessionID: string;
        output: Extract<IntentResolverOutput, { status: "needs_clarification" }>;
        workspaceRoot: string;
        originalText: string;
        pending: BridgeIntentResolverState | null;
    }): Promise<void> {
        const state = await this.loadState();
        const timestamp = this.now().toISOString();
        const turnCount = (input.pending?.turnCount ?? 0) + 1;
        if (turnCount > this.config.intentResolver.maxClarificationTurns) {
            if (input.pending) {
                removeIntentResolver(state, input.pending.id);
            }
            state.updatedAt = timestamp;
            await writeBridgeState(this.config.statePath, state);
            await this.send(input.channelID, "[bridge] intent resolver reached the clarification limit. Send the intent again with more detail.");
            return;
        }

        const pending: BridgeIntentResolverState = {
            id: input.pending?.id ?? createIntentResolverID(state, this.now()),
            platform: "discord",
            surfaceID: surfaceID(input.channelID),
            surface: surfaceAddress(input.channelID),
            userID: input.userID,
            resolverSessionID: input.resolverSessionID,
            workspaceRoot: input.workspaceRoot,
            originalText: input.originalText,
            turnCount,
            maxTurns: this.config.intentResolver.maxClarificationTurns,
            expiresAt: new Date(this.now().getTime() + this.config.intentResolver.clarificationTtlMs).toISOString(),
            lastQuestion: input.output.question,
            allowFreeText: input.output.allowFreeText,
            options: input.output.options.map((option) => option.value === undefined
                ? { id: option.id, label: option.label }
                : { id: option.id, label: option.label, value: option.value }),
            createdAt: input.pending?.createdAt ?? timestamp,
            updatedAt: timestamp,
        };

        upsertIntentResolver(state, pending);
        state.updatedAt = timestamp;
        await writeBridgeState(this.config.statePath, state);
        await this.sendClarification(input.channelID, pending);
    }

    private async startResolvedIntentSession(channelID: string, output: IntentResolverReadyOutput): Promise<void> {
        const sessionInput: { title?: string; directory?: string } = { directory: output.path };
        if (output.title !== null) {
            sessionInput.title = output.title;
        }

        const session = await this.opencode.createSession(sessionInput);
        await this.bind(channelID, session);
        await this.opencode.sendPrompt({ sessionID: session.id, text: output.prompt, directory: output.path });
        await this.send(channelID, `[bridge] resolved ${formatSessionLine(session)} at ${output.path}; prompt sent`);
    }

    private async sendClarification(channelID: string, pending: BridgeIntentResolverState): Promise<void> {
        await this.send(channelID, `[bridge] ${pending.lastQuestion}`, { components: clarificationComponents(pending) });
    }

    private async removePendingResolver(id: string): Promise<void> {
        const state = await this.loadState();
        removeIntentResolver(state, id);
        state.updatedAt = this.now().toISOString();
        await writeBridgeState(this.config.statePath, state);
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

    private async handleJobs(channelID: string): Promise<void> {
        const state = await this.loadState();
        const jobs = jobsForSurface(state, surfaceID(channelID));
        if (jobs.length === 0) {
            await this.send(channelID, "[bridge] no scheduled jobs for this channel");
            return;
        }

        await this.send(channelID, jobs.map(formatDiscordJobLine).join("\n"));
    }

    private async handleSchedule(channelID: string, args: string[]): Promise<void> {
        const parsed = parseScheduleArgs(args);
        if (!parsed.ok) {
            await this.send(channelID, `[bridge] ${parsed.message}`);
            return;
        }

        const state = await this.loadState();
        const id = surfaceID(channelID);
        const surface = findSurface(state, id);
        if (!surface?.activeSessionID) {
            await this.send(channelID, `[bridge] no active session. Use ${this.config.discord.prefix} attach latest or ${this.config.discord.prefix} new first.`);
            return;
        }

        const now = this.now();
        const timestamp = now.toISOString();
        const job: BridgeScheduledJobState = {
            id: createScheduledJobID(state, now),
            platform: "discord",
            surfaceID: id,
            surface: surface.surface,
            sessionID: surface.activeSessionID,
            prompt: parsed.prompt,
            intervalMinutes: parsed.intervalMinutes,
            nextRunAt: nextScheduledRun(now, parsed.intervalMinutes),
            lastRunAt: null,
            lastError: null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        state.jobs.push(job);
        state.updatedAt = timestamp;

        await writeBridgeState(this.config.statePath, state);
        await this.send(channelID, `[bridge] scheduled ${job.id} every ${formatScheduleInterval(job.intervalMinutes)} for ${job.sessionID}`);
    }

    private async handleUnschedule(channelID: string, jobID: string | undefined): Promise<void> {
        if (!jobID) {
            await this.send(channelID, "[bridge] job ID is required");
            return;
        }

        const state = await this.loadState();
        const index = state.jobs.findIndex((job) => job.surfaceID === surfaceID(channelID) && job.id === jobID);
        if (index === -1) {
            await this.send(channelID, "[bridge] scheduled job not found for this channel");
            return;
        }

        state.jobs.splice(index, 1);
        state.updatedAt = this.now().toISOString();

        await writeBridgeState(this.config.statePath, state);
        await this.send(channelID, `[bridge] unscheduled ${jobID}`);
    }

    private async handleRunNow(channelID: string, jobID: string | undefined): Promise<void> {
        if (!jobID) {
            await this.send(channelID, "[bridge] job ID is required");
            return;
        }

        const state = await this.loadState();
        const job = state.jobs.find((entry) => entry.surfaceID === surfaceID(channelID) && entry.id === jobID);
        if (!job) {
            await this.send(channelID, "[bridge] scheduled job not found for this channel");
            return;
        }

        const now = this.now();
        await this.discord.sendTyping({ channelID });
        try {
            await this.opencode.sendPrompt({ sessionID: job.sessionID, text: job.prompt });
            recordScheduledJobRun(job, now, null);
            state.updatedAt = now.toISOString();
            await writeBridgeState(this.config.statePath, state);
            await this.send(channelID, `[bridge] ran scheduled job ${job.id} for ${job.sessionID}`);
        } catch (error) {
            const message = scheduleErrorMessage(error);
            recordScheduledJobRun(job, now, message);
            state.updatedAt = now.toISOString();
            await writeBridgeState(this.config.statePath, state);
            await this.send(channelID, `[bridge] scheduled job ${job.id} failed: ${message}`);
        }
    }

    private async handlePermissionReply(channelID: string, command: "allow" | "always" | "deny", args: string[]): Promise<void> {
        const permissionID = args[0]?.trim();
        if (!permissionID) {
            await this.send(channelID, "[bridge] permission ID is required");
            return;
        }

        const state = await this.loadState();
        const activeSessionID = findSurface(state, surfaceID(channelID))?.activeSessionID ?? undefined;
        const response = permissionResponseForCommand(command);
        const input: { sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string } = {
            permissionID,
            response,
        };
        if (activeSessionID) {
            input.sessionID = activeSessionID;
        }

        const feedback = command === "deny" ? args.slice(1).join(" ").trim() : "";
        if (feedback) {
            input.message = feedback;
        }

        await this.opencode.replyPermission(input);
        await this.send(channelID, `[bridge] permission ${response} sent for ${permissionID}`);
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

    private async send(channelID: string, content: string, options: { components?: DiscordMessageComponent[] } = {}): Promise<void> {
        const input: SendDiscordMessageInput = { channelID, content };
        if (options.components && options.components.length > 0) {
            input.components = options.components;
        }

        await this.discord.sendMessage(input);
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
            `- ${prefix} allow <permission-id>, ${prefix} always <permission-id>, or ${prefix} deny <permission-id>`,
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
    if (name === "schedule") {
        const text = optionValue(options, "text");
        return { name, args: text.split(/\s+/).filter((entry) => entry.length > 0), text };
    }
    if (name === "unschedule" || name === "run-now") {
        const jobID = optionValue(options, "job_id");
        return { name, args: jobID ? [jobID] : [], text: jobID };
    }
    if (name === "allow" || name === "always" || name === "deny") {
        const permissionID = optionValue(options, "permission_id");
        const message = name === "deny" ? optionValue(options, "message") : "";
        const args = [permissionID, message].filter((entry) => entry.length > 0);
        return { name, args, text: args.join(" ") };
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

function jobsForSurface(state: BridgeState, id: string): BridgeScheduledJobState[] {
    return state.jobs.filter((job) => job.surfaceID === id);
}

function findPendingIntentResolver(state: BridgeState, platform: "discord", id: string, userID: string): BridgeIntentResolverState | undefined {
    return state.intentResolvers.find((entry) => entry.platform === platform && entry.surfaceID === id && entry.userID === userID);
}

function upsertIntentResolver(state: BridgeState, resolver: BridgeIntentResolverState): void {
    const index = state.intentResolvers.findIndex((entry) => entry.id === resolver.id);
    if (index === -1) {
        state.intentResolvers.push(resolver);
        return;
    }

    state.intentResolvers[index] = resolver;
}

function removeIntentResolver(state: BridgeState, id: string): void {
    const index = state.intentResolvers.findIndex((entry) => entry.id === id);
    if (index !== -1) {
        state.intentResolvers.splice(index, 1);
    }
}

function createIntentResolverID(state: BridgeState, now: Date): string {
    return `ir_${now.getTime().toString(36)}_${(state.intentResolvers.length + 1).toString(36)}`;
}

function resolverExpired(resolver: BridgeIntentResolverState, now: Date): boolean {
    const expiresAt = Date.parse(resolver.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function clarificationComponents(pending: BridgeIntentResolverState): DiscordMessageComponent[] {
    if (pending.options.length === 0) {
        return [];
    }

    return [
        {
            type: DISCORD_COMPONENT_ACTION_ROW,
            components: [
                {
                    type: DISCORD_COMPONENT_STRING_SELECT,
                    custom_id: intentSelectCustomID(pending.id),
                    placeholder: DISCORD_SELECT_PLACEHOLDER,
                    min_values: 1,
                    max_values: 1,
                    options: pending.options.map((option, index) => ({
                        label: truncateDiscordComponentText(option.label, DISCORD_SELECT_LABEL_LIMIT),
                        value: index.toString(36),
                    })),
                },
            ],
        },
    ];
}

function intentSelectCustomID(resolverID: string): string {
    return `${DISCORD_INTENT_COMPONENT_PREFIX}:${resolverID}`;
}

function parseIntentComponentData(data: DiscordInteraction["data"]): { resolverID: string; optionIndex: number } | null {
    const customID = data?.customID;
    if (!customID) {
        return null;
    }

    const parts = customID.split(":");
    if (parts.length !== 2 && parts.length !== 3) {
        return null;
    }
    if (parts[0] !== DISCORD_INTENT_COMPONENT_PREFIX || !parts[1]) {
        return null;
    }

    const optionValue = parts.length === 3 ? parts[2] : data.values[0];
    const optionIndex = Number.parseInt(optionValue ?? "", 36);
    if (!Number.isInteger(optionIndex) || optionIndex < 0) {
        return null;
    }

    return { resolverID: parts[1], optionIndex };
}

function truncateDiscordComponentText(value: string, limit: number): string {
    return Array.from(value).slice(0, limit).join("") || "Option";
}

function firstAudioAttachment(attachments: DiscordAttachment[]): DiscordAttachment | null {
    return attachments.find((attachment) => {
        const contentType = attachment.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
        return contentType.startsWith("audio/") || audioFormatFromMetadata({ mimeType: attachment.contentType, fileName: attachment.filename }) !== null;
    }) ?? null;
}

function audioErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatDiscordJobLine(job: BridgeScheduledJobState): string {
    const line = `[bridge] ${job.id} every ${formatScheduleInterval(job.intervalMinutes)} next ${job.nextRunAt} session ${job.sessionID}`;
    if (!job.lastError) {
        return line;
    }

    return `${line} last error: ${job.lastError}`;
}

function formatSessionLine(session: OpenCodeSession): string {
    return `${session.id}\t${session.title ?? "(untitled)"}`;
}

function permissionResponseForCommand(command: "allow" | "always" | "deny"): OpenCodePermissionResponse {
    if (command === "allow") {
        return "once";
    }
    if (command === "always") {
        return "always";
    }

    return "reject";
}
