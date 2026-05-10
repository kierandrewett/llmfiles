import {
    createScheduledJobID,
    formatScheduleInterval,
    nextScheduledRun,
    parseScheduleArgs,
    recordScheduledJobRun,
    scheduleErrorMessage,
} from "./automation.js";
import type { BridgeConfig } from "./config.js";
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
    TELEGRAM_MARKDOWN_PARSE_MODE,
    chunkTelegramText,
    escapeTelegramMarkdown,
    type AnswerCallbackQueryInput,
    type CreateForumTopicInput,
    type DownloadFileInput,
    type GetFileInput,
    type SendChatActionInput,
    type SendMessageInput,
    type SetMessageReactionInput,
    type TelegramFile,
    type TelegramForumTopic,
    type TelegramCallbackQuery,
    type TelegramMessage,
    type TelegramUpdate,
} from "./telegram.js";
import {
    audioFormatFromMetadata,
    enforceAudioSizeLimit,
    type OpenRouterAudioFormat,
    type TranscriptionResult,
} from "./voice.js";

const TELEGRAM_REACTION_DONE = "\u{1F44D}";
const TELEGRAM_REACTION_UNKNOWN = "\u{1F914}";
const TELEGRAM_INTENT_CALLBACK_PREFIX = "ir";
const TELEGRAM_DIRECT_COMMANDS = new Set([
    "status",
    "sessions",
    "attach",
    "new",
    "prompt",
    "reply",
    "abort",
    "jobs",
    "schedule",
    "unschedule",
    "run_now",
    "allow",
    "always",
    "deny",
]);

export interface TelegramRouterOpenCodeClient {
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number; directory?: string }): Promise<OpenCodeSession[]>;
    getSession(input: { sessionID: string; directory?: string }): Promise<OpenCodeSession>;
    createSession(input?: { title?: string; directory?: string }): Promise<OpenCodeSession>;
    sendPrompt(input: { sessionID: string; text: string; directory?: string }): Promise<void>;
    abortSession(input: { sessionID: string; directory?: string }): Promise<void>;
    replyPermission(input: { sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string; directory?: string }): Promise<void>;
}

export interface TelegramRouterTelegramClient {
    sendMessage(input: SendMessageInput): Promise<unknown>;
    sendChatAction(input: SendChatActionInput): Promise<void>;
    setMessageReaction(input: SetMessageReactionInput): Promise<void>;
    answerCallbackQuery(input: AnswerCallbackQueryInput): Promise<void>;
    createForumTopic(input: CreateForumTopicInput): Promise<TelegramForumTopic>;
    getFile(input: GetFileInput): Promise<TelegramFile>;
    downloadFile(input: DownloadFileInput): Promise<Uint8Array>;
}

export interface TelegramVoiceTranscriber {
    transcribe(input: { data: Uint8Array; format: OpenRouterAudioFormat }): Promise<TranscriptionResult>;
}

export interface TelegramIntentResolverRunResult {
    resolverSessionID: string;
    output: IntentResolverOutput;
}

export interface TelegramIntentResolver {
    start(input: { text: string; workspaceRoot: string }): Promise<TelegramIntentResolverRunResult>;
    continue(input: { resolverSessionID: string; answer: string; workspaceRoot: string }): Promise<TelegramIntentResolverRunResult>;
}

export interface TelegramBridgeRouterDependencies {
    config: BridgeConfig;
    opencode: TelegramRouterOpenCodeClient;
    telegram: TelegramRouterTelegramClient;
    intentResolver?: TelegramIntentResolver;
    transcriber?: TelegramVoiceTranscriber;
    now?: () => Date;
}

interface ParsedCommand {
    name: string;
    args: string[];
}

interface NewSessionSurface {
    message: TelegramMessage;
    topicCreationFailed: boolean;
}

export class TelegramBridgeRouter {
    private readonly config: BridgeConfig;
    private readonly opencode: TelegramRouterOpenCodeClient;
    private readonly telegram: TelegramRouterTelegramClient;
    private readonly intentResolver: TelegramIntentResolver | null;
    private readonly transcriber: TelegramVoiceTranscriber | null;
    private readonly now: () => Date;

    constructor(dependencies: TelegramBridgeRouterDependencies) {
        this.config = dependencies.config;
        this.opencode = dependencies.opencode;
        this.telegram = dependencies.telegram;
        this.intentResolver = dependencies.intentResolver ?? null;
        this.transcriber = dependencies.transcriber ?? null;
        this.now = dependencies.now ?? (() => new Date());
    }

    async handleUpdate(update: TelegramUpdate): Promise<void> {
        if (update.callbackQuery) {
            await this.handleCallbackQuery(update.callbackQuery);
            return;
        }

        const message = update.message;
        if (!message || !this.isAllowed(message)) {
            return;
        }
        if (!message.text) {
            if (message.audio) {
                await this.handleAudioPrompt(message);
                await this.react(message, TELEGRAM_REACTION_DONE);
            }

            return;
        }

        const command = parseCommand(message.text);
        if (!command) {
            if (await this.handlePendingResolverText(message, message.text)) {
                await this.react(message, TELEGRAM_REACTION_DONE);
                return;
            }
            if (this.config.intentResolver.enabled) {
                await this.handleIntentResolverStart(message, message.text);
                await this.react(message, TELEGRAM_REACTION_DONE);
                return;
            }
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
        if (command.name === "jobs") {
            await this.handleJobs(message);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "schedule") {
            await this.handleSchedule(message, command.args);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "unschedule") {
            await this.handleUnschedule(message, command.args[0]);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "run-now") {
            await this.handleRunNow(message, command.args[0]);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }
        if (command.name === "allow" || command.name === "always" || command.name === "deny") {
            await this.handlePermissionReply(message, command.name, command.args);
            await this.react(message, TELEGRAM_REACTION_DONE);
            return;
        }

        await this.send(
            message,
            bridgePlain("unknown command. Try /oc status, /oc sessions, /oc attach latest, /oc new, /oc prompt, /oc schedule, or /oc allow."),
        );
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

        const session = target === "latest"
            ? await this.latestSession()
            : await this.opencode.getSession({ sessionID: target });
        if (!session) {
            await this.send(message, bridgePlain("no sessions found"));
            return;
        }

        await this.bind(message, session);
        await this.send(message, bridgeLine(`attached ${formatSessionLine(session)}`));
    }

    private async handleNew(message: TelegramMessage, title: string): Promise<void> {
        const session = await this.opencode.createSession(title ? { title } : {});
        const surface = await this.surfaceForNewSession(message, session, title);
        const lines = [bridgeLine(`created and attached ${formatSessionLine(session)}`)];
        if (surface.topicCreationFailed) {
            lines.push(bridgePlain("topic creation failed; bound this chat instead"));
        }

        await this.bind(surface.message, session);
        await this.send(surface.message, lines.join("\n"));
    }

    private async surfaceForNewSession(message: TelegramMessage, session: OpenCodeSession, title: string): Promise<NewSessionSurface> {
        if (!shouldCreateTopic(this.config, message)) {
            return { message, topicCreationFailed: false };
        }

        try {
            const topic = await this.telegram.createForumTopic({
                chatID: message.chatID,
                name: topicNameForSession(session, title),
            });

            return { message: { ...message, threadID: topic.messageThreadID }, topicCreationFailed: false };
        } catch {
            return { message, topicCreationFailed: true };
        }
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

    private async handleAudioPrompt(message: TelegramMessage): Promise<void> {
        const attachment = message.audio;
        if (!attachment) {
            return;
        }

        const state = await this.loadState();
        const surface = findSurface(state, surfaceID(message));
        if (!surface?.activeSessionID) {
            await this.send(message, bridgePlain("no active session. Use /oc attach latest or /oc new first."));
            return;
        }
        if (!this.config.voice.enabled || this.transcriber === null) {
            await this.send(message, bridgePlain("voice transcription is disabled"));
            return;
        }

        const format = audioFormatFromMetadata({ mimeType: attachment.mimeType, fileName: attachment.fileName });
        if (format === null) {
            await this.send(message, bridgePlain("unsupported audio format. Use wav, mp3, flac, m4a, ogg, webm, or aac."));
            return;
        }

        await this.telegram.sendChatAction({ chatID: message.chatID, threadID: message.threadID, action: "typing" });
        try {
            enforceAudioSizeLimit(attachment.fileSize, this.config.voice.maxAudioBytes);
            const file = await this.telegram.getFile({ fileID: attachment.fileID });
            if (file.path === null) {
                await this.send(message, bridgePlain("Telegram did not return a downloadable file path for this audio."));
                return;
            }
            enforceAudioSizeLimit(file.size, this.config.voice.maxAudioBytes);
            const audio = await this.telegram.downloadFile({ filePath: file.path });
            enforceAudioSizeLimit(audio.byteLength, this.config.voice.maxAudioBytes);
            const transcription = await this.transcriber.transcribe({ data: audio, format });
            const text = transcription.text.trim();
            if (text.length === 0) {
                await this.send(message, bridgePlain("audio transcription was empty"));
                return;
            }

            await this.opencode.sendPrompt({ sessionID: surface.activeSessionID, text });
            await this.send(message, bridgeLine(`transcribed audio sent to ${markdownCode(surface.activeSessionID)}`));
        } catch (error) {
            await this.send(message, bridgeLine(`audio transcription failed: ${escapeTelegramMarkdown(audioErrorMessage(error))}`));
        }
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

    private async handleJobs(message: TelegramMessage): Promise<void> {
        const state = await this.loadState();
        const jobs = jobsForSurface(state, surfaceID(message));
        if (jobs.length === 0) {
            await this.send(message, bridgePlain("no scheduled jobs for this chat"));
            return;
        }

        await this.send(message, jobs.map(formatTelegramJobLine).join("\n"));
    }

    private async handleSchedule(message: TelegramMessage, args: string[]): Promise<void> {
        const parsed = parseScheduleArgs(args);
        if (!parsed.ok) {
            await this.send(message, bridgePlain(parsed.message));
            return;
        }

        const state = await this.loadState();
        const id = surfaceID(message);
        const surface = findSurface(state, id);
        if (!surface?.activeSessionID) {
            await this.send(message, bridgePlain("no active session. Use /oc attach latest or /oc new first."));
            return;
        }

        const now = this.now();
        const timestamp = now.toISOString();
        const job: BridgeScheduledJobState = {
            id: createScheduledJobID(state, now),
            platform: "telegram",
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
        await this.send(message, bridgeLine(`scheduled ${markdownCode(job.id)} every ${markdownCode(formatScheduleInterval(job.intervalMinutes))} for ${markdownCode(job.sessionID)}`));
    }

    private async handleUnschedule(message: TelegramMessage, jobID: string | undefined): Promise<void> {
        if (!jobID) {
            await this.send(message, bridgePlain("job ID is required"));
            return;
        }

        const state = await this.loadState();
        const index = state.jobs.findIndex((job) => job.surfaceID === surfaceID(message) && job.id === jobID);
        if (index === -1) {
            await this.send(message, bridgePlain("scheduled job not found for this chat"));
            return;
        }

        state.jobs.splice(index, 1);
        state.updatedAt = this.now().toISOString();

        await writeBridgeState(this.config.statePath, state);
        await this.send(message, bridgeLine(`unscheduled ${markdownCode(jobID)}`));
    }

    private async handleRunNow(message: TelegramMessage, jobID: string | undefined): Promise<void> {
        if (!jobID) {
            await this.send(message, bridgePlain("job ID is required"));
            return;
        }

        const state = await this.loadState();
        const job = state.jobs.find((entry) => entry.surfaceID === surfaceID(message) && entry.id === jobID);
        if (!job) {
            await this.send(message, bridgePlain("scheduled job not found for this chat"));
            return;
        }

        const now = this.now();
        await this.telegram.sendChatAction({ chatID: message.chatID, threadID: message.threadID, action: "typing" });
        try {
            await this.opencode.sendPrompt({ sessionID: job.sessionID, text: job.prompt });
            recordScheduledJobRun(job, now, null);
            state.updatedAt = now.toISOString();
            await writeBridgeState(this.config.statePath, state);
            await this.send(message, bridgeLine(`ran scheduled job ${markdownCode(job.id)} for ${markdownCode(job.sessionID)}`));
        } catch (error) {
            const messageText = scheduleErrorMessage(error);
            recordScheduledJobRun(job, now, messageText);
            state.updatedAt = now.toISOString();
            await writeBridgeState(this.config.statePath, state);
            await this.send(message, bridgeLine(`scheduled job ${markdownCode(job.id)} failed: ${escapeTelegramMarkdown(messageText)}`));
        }
    }

    private async handlePermissionReply(message: TelegramMessage, command: "allow" | "always" | "deny", args: string[]): Promise<void> {
        const permissionID = args[0]?.trim();
        if (!permissionID) {
            await this.send(message, bridgePlain("permission ID is required"));
            return;
        }

        const state = await this.loadState();
        const activeSessionID = findSurface(state, surfaceID(message))?.activeSessionID ?? undefined;
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
        await this.send(message, bridgeLine(`permission ${markdownCode(response)} sent for ${markdownCode(permissionID)}`));
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
        name: directCommand === "run_now" ? "run-now" : directCommand,
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
    const address: BridgeSurfaceAddress = {
        chatID: message.chatID,
        threadID: message.threadID,
    };

    if (message.chatType) {
        address.chatType = message.chatType;
    }

    return address;
}

function shouldCreateTopic(config: BridgeConfig, message: TelegramMessage): boolean {
    if (!config.telegram.createTopics || message.threadID !== null) {
        return false;
    }

    return message.chatType === "private" || message.chatType === "supergroup";
}

function topicNameForSession(session: OpenCodeSession, requestedTitle: string): string {
    return truncateTopicName(normaliseTopicName(requestedTitle) || normaliseTopicName(session.title) || session.id);
}

function normaliseTopicName(value: string | null | undefined): string {
    return value?.replace(/\s+/g, " ").trim() ?? "";
}

function truncateTopicName(value: string): string {
    return Array.from(value).slice(0, 128).join("");
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

function formatTelegramJobLine(job: BridgeScheduledJobState): string {
    const line = bridgeLine(`${markdownCode(job.id)} every ${markdownCode(formatScheduleInterval(job.intervalMinutes))} next ${markdownCode(job.nextRunAt)} session ${markdownCode(job.sessionID)}`);
    if (!job.lastError) {
        return line;
    }

    return `${line} ${escapeTelegramMarkdown("last error")}: ${escapeTelegramMarkdown(job.lastError)}`;
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

function audioErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function markdownBold(text: string): string {
    return `*${escapeTelegramMarkdown(text)}*`;
}

function markdownCode(text: string): string {
    return `\`${text.replace(/[\\`]/g, (character) => `\\${character}`)}\``;
}
