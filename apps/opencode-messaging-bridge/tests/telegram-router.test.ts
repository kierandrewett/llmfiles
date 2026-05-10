import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { type BridgeConfig } from "../src/config.js";
import type { IntentResolverOutput } from "../src/intent-resolver.js";
import { type OpenCodeHealth, type OpenCodePermissionResponse, type OpenCodeSession } from "../src/opencode.js";
import { readBridgeState, writeBridgeState, createDefaultBridgeState } from "../src/state.js";
import { TelegramBridgeRouter } from "../src/telegram-router.js";
import {
    type AnswerCallbackQueryInput,
    TELEGRAM_MARKDOWN_PARSE_MODE,
    type CreateForumTopicInput,
    type SendChatActionInput,
    type SendMessageInput,
    type SetMessageReactionInput,
    type TelegramForumTopic,
    type TelegramUpdate,
} from "../src/telegram.js";
import type { OpenRouterAudioFormat, TranscriptionResult } from "../src/voice.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("TelegramBridgeRouter", () => {
    it("ignores messages from users outside the allowlist", async () => {
        const fixture = await createFixture();
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("999", "123", "/oc status"));

        assert.deepEqual(fixture.telegram.messages, []);
        assert.equal(fixture.opencode.healthCalls, 0);
    });

    it("responds to status commands", async () => {
        const fixture = await createFixture();
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc status"));

        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), [
            "*\\[bridge\\]* OpenCode healthy: `true`\n*\\[bridge\\]* OpenCode version: `1.3.17`\n*\\[bridge\\]* active session: `none`",
        ]);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.parseMode), [TELEGRAM_MARKDOWN_PARSE_MODE]);
        assert.deepEqual(fixture.telegram.reactions, [{ chatID: "456", messageID: 10, emoji: "\u{1F44D}" }]);
    });

    it("responds to first-class Telegram command menu commands", async () => {
        const fixture = await createFixture();
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/status@OpenCodeBridgeBot"));

        assert.equal(fixture.opencode.healthCalls, 1);
        assert.deepEqual(fixture.telegram.reactions, [{ chatID: "456", messageID: 10, emoji: "\u{1F44D}" }]);
    });

    it("lists recent sessions", async () => {
        const fixture = await createFixture({ sessions: [{ id: "ses_abc", title: "Example", directory: null, time: null }] });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc sessions"));

        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["`ses_abc` Example"]);
    });

    it("attaches the latest session and persists the binding", async () => {
        const fixture = await createFixture({ sessions: [{ id: "ses_abc", title: "Example", directory: "/tmp/project", time: null }] });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc attach latest", "42"));

        const state = await readBridgeState(fixture.statePath);
        assert.equal(state.surfaces[0]?.id, "telegram:456:42");
        assert.equal(state.surfaces[0]?.activeSessionID, "ses_abc");
        assert.equal(state.bindings[0]?.sessionID, "ses_abc");
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["*\\[bridge\\]* attached `ses_abc` Example"]);
    });

    it("creates a session and binds it to the Telegram surface", async () => {
        const fixture = await createFixture({ createdSession: { id: "ses_new", title: "New work", directory: null, time: null } });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc new New work"));

        const state = await readBridgeState(fixture.statePath);
        assert.deepEqual(fixture.opencode.createdTitles, ["New work"]);
        assert.equal(state.surfaces[0]?.activeSessionID, "ses_new");
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["*\\[bridge\\]* created and attached `ses_new` New work"]);
    });

    it("creates a Telegram topic for a new session when topic creation is enabled", async () => {
        const fixture = await createFixture({
            createTopics: true,
            createdSession: { id: "ses_new", title: "New work", directory: null, time: null },
            topic: { messageThreadID: "777", name: "New work", iconColor: 7322096, iconCustomEmojiID: null, isNameImplicit: false },
        });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc new New work", null, "supergroup"));

        const state = await readBridgeState(fixture.statePath);
        assert.deepEqual(fixture.telegram.topics, [{ chatID: "456", name: "New work" }]);
        assert.equal(state.surfaces[0]?.id, "telegram:456:777");
        assert.equal(state.surfaces[0]?.surface.threadID, "777");
        assert.equal(state.surfaces[0]?.activeSessionID, "ses_new");
        assert.equal(state.bindings[0]?.surface.threadID, "777");
        assert.deepEqual(fixture.telegram.messages.map((message) => message.threadID), ["777"]);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["*\\[bridge\\]* created and attached `ses_new` New work"]);
    });

    it("falls back to the current Telegram surface when topic creation fails", async () => {
        const fixture = await createFixture({
            createTopics: true,
            failTopicCreation: true,
            createdSession: { id: "ses_new", title: "New work", directory: null, time: null },
        });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc new New work", null, "supergroup"));

        const state = await readBridgeState(fixture.statePath);
        assert.deepEqual(fixture.telegram.topics, [{ chatID: "456", name: "New work" }]);
        assert.equal(state.surfaces[0]?.id, "telegram:456:");
        assert.equal(state.surfaces[0]?.surface.threadID, null);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.threadID), [null]);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), [
            "*\\[bridge\\]* created and attached `ses_new` New work\n*\\[bridge\\]* topic creation failed; bound this chat instead",
        ]);
    });

    it("sends prompts to the active session", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "telegram:456:", platform: "telegram", surface: { chatID: "456", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        state.bindings.push({
            id: "telegram:456::ses_abc",
            platform: "telegram",
            surface: { chatID: "456", threadID: null },
            sessionID: "ses_abc",
            directory: null,
            title: "Example",
            createdAt: state.updatedAt,
            updatedAt: state.updatedAt,
        });
        await writeBridgeState(fixture.statePath, state);
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc prompt hello there"));

        assert.deepEqual(fixture.telegram.actions, [{ chatID: "456", threadID: null, action: "typing" }]);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_abc", text: "hello there" }]);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["*\\[bridge\\]* prompt sent to `ses_abc`"]);
    });

    it("transcribes Telegram voice messages and sends them to the active session", async () => {
        const fixture = await createFixture({ voiceEnabled: true, transcriptionText: "hello from voice" });
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "telegram:456:", platform: "telegram", surface: { chatID: "456", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        await writeBridgeState(fixture.statePath, state);
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(voiceUpdate("123", "456", { fileID: "voice-file", mimeType: "audio/ogg", fileSize: 3 }));

        assert.deepEqual(fixture.telegram.fileRequests, [{ fileID: "voice-file" }]);
        assert.deepEqual(fixture.telegram.downloads, [{ filePath: "voice/file.ogg" }]);
        assert.deepEqual(fixture.transcriber.transcriptions, [{ data: [1, 2, 3], format: "ogg" }]);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_abc", text: "hello from voice" }]);
        assert.deepEqual(fixture.telegram.actions, [{ chatID: "456", threadID: null, action: "typing" }]);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["*\\[bridge\\]* transcribed audio sent to `ses_abc`"]);
        assert.deepEqual(fixture.telegram.reactions, [{ chatID: "456", messageID: 10, emoji: "\u{1F44D}" }]);
    });

    it("starts the workspace intent resolver for short Telegram intents and asks with inline options", async () => {
        const fixture = await createFixture({
            intentResolverEnabled: true,
            workspaceRoot: "/workspace/dev",
            resolverOutputs: [
                {
                    resolverSessionID: "ses_resolver",
                    output: {
                        status: "needs_clarification",
                        question: "Which repository?",
                        allowFreeText: false,
                        options: [
                            { id: "repo-api", label: "api", value: "api" },
                        ],
                    },
                },
            ],
        });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "work on api"));

        const state = await readBridgeState(fixture.statePath);
        const pending = state.intentResolvers[0];
        assert.ok(pending);
        assert.deepEqual(fixture.resolver.starts, [{ text: "work on api", workspaceRoot: "/workspace/dev" }]);
        assert.equal(pending.platform, "telegram");
        assert.equal(pending.surfaceID, "telegram:456:");
        assert.equal(pending.userID, "123");
        assert.equal(pending.resolverSessionID, "ses_resolver");
        assert.equal(pending.originalText, "work on api");
        assert.equal(pending.turnCount, 1);
        assert.equal(pending.maxTurns, 4);
        assert.equal(pending.expiresAt, "2026-05-09T00:10:00.000Z");
        assert.equal(pending.lastQuestion, "Which repository?");
        assert.equal(pending.allowFreeText, false);
        assert.deepEqual(pending.options, [{ id: "repo-api", label: "api", value: "api" }]);
        assert.deepEqual(fixture.telegram.messages, [
            {
                chatID: "456",
                threadID: null,
                text: "*\\[bridge\\]* Which repository?",
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
                replyMarkup: {
                    inlineKeyboard: [
                        [
                            { text: "api", callbackData: `ir:${pending.id}:0` },
                        ],
                    ],
                },
            },
        ]);
    });

    it("continues a pending resolver from an inline callback and starts the resolved workspace session", async () => {
        const fixture = await createFixture({
            intentResolverEnabled: true,
            workspaceRoot: "/workspace/dev",
            createdSession: { id: "ses_api", title: "api", directory: "/workspace/dev/api", time: null },
            resolverOutputs: [
                {
                    resolverSessionID: "ses_resolver",
                    output: {
                        status: "ready",
                        path: "/workspace/dev/api",
                        prompt: "Fix the failing tests.",
                        title: "api",
                        action: "create_session",
                        metadata: {},
                    },
                },
            ],
        });
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.intentResolvers.push(pendingResolverState({ id: "ir_existing", allowFreeText: false }));
        await writeBridgeState(fixture.statePath, state);
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(callbackUpdate("123", "456", "callback-1", "ir:ir_existing:0"));

        const read = await readBridgeState(fixture.statePath);
        assert.deepEqual(fixture.telegram.callbackAnswers, [{ callbackQueryID: "callback-1", text: "Working on it" }]);
        assert.deepEqual(fixture.resolver.continuations, [
            { resolverSessionID: "ses_resolver", answer: "api", workspaceRoot: "/workspace/dev" },
        ]);
        assert.deepEqual(fixture.opencode.createdSessions, [{ title: "api", directory: "/workspace/dev/api" }]);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_api", text: "Fix the failing tests.", directory: "/workspace/dev/api" }]);
        assert.deepEqual(read.intentResolvers, []);
        assert.equal(read.surfaces[0]?.activeSessionID, "ses_api");
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), [
            "*\\[bridge\\]* resolved `ses_api` api at `/workspace/dev/api`; prompt sent",
        ]);
    });

    it("continues a pending resolver from free text when the clarification allows it", async () => {
        const fixture = await createFixture({
            intentResolverEnabled: true,
            workspaceRoot: "/workspace/dev",
            createdSession: { id: "ses_api", title: "api", directory: "/workspace/dev/api", time: null },
            resolverOutputs: [
                {
                    resolverSessionID: "ses_resolver",
                    output: {
                        status: "ready",
                        path: "/workspace/dev/api",
                        prompt: "Fix the failing tests.",
                        title: "api",
                        action: "create_session",
                        metadata: {},
                    },
                },
            ],
        });
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.intentResolvers.push(pendingResolverState({ id: "ir_existing", allowFreeText: true }));
        await writeBridgeState(fixture.statePath, state);
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "the api repo"));

        assert.deepEqual(fixture.resolver.starts, []);
        assert.deepEqual(fixture.resolver.continuations, [
            { resolverSessionID: "ses_resolver", answer: "the api repo", workspaceRoot: "/workspace/dev" },
        ]);
        assert.deepEqual(fixture.telegram.reactions, [{ chatID: "456", messageID: 10, emoji: "\u{1F44D}" }]);
    });

    it("does not transcribe Telegram voice messages before a session is attached", async () => {
        const fixture = await createFixture({ voiceEnabled: true, transcriptionText: "hello from voice" });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(voiceUpdate("123", "456", { fileID: "voice-file", mimeType: "audio/ogg", fileSize: 3 }));

        assert.deepEqual(fixture.telegram.fileRequests, []);
        assert.deepEqual(fixture.transcriber.transcriptions, []);
        assert.deepEqual(fixture.opencode.prompts, []);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["*\\[bridge\\]* no active session\\. Use /oc attach latest or /oc new first\\."]);
    });

    it("schedules prompts against the active Telegram session", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "telegram:456:", platform: "telegram", surface: { chatID: "456", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        await writeBridgeState(fixture.statePath, state);
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc schedule every 15m check status"));
        await router.handleUpdate(update("123", "456", "/oc jobs"));

        const read = await readBridgeState(fixture.statePath);
        assert.equal(read.jobs.length, 1);
        assert.equal(read.jobs[0]?.id, "job_20260509T000000000Z_1");
        assert.equal(read.jobs[0]?.sessionID, "ses_abc");
        assert.equal(read.jobs[0]?.prompt, "check status");
        assert.equal(read.jobs[0]?.nextRunAt, "2026-05-09T00:15:00.000Z");
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), [
            "*\\[bridge\\]* scheduled `job_20260509T000000000Z_1` every `15m` for `ses_abc`",
            "*\\[bridge\\]* `job_20260509T000000000Z_1` every `15m` next `2026-05-09T00:15:00.000Z` session `ses_abc`",
        ]);
    });

    it("runs and unschedules Telegram scheduled prompts by job ID", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "telegram:456:", platform: "telegram", surface: { chatID: "456", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        state.jobs.push({
            id: "job_1",
            platform: "telegram",
            surfaceID: "telegram:456:",
            surface: { chatID: "456", threadID: null },
            sessionID: "ses_abc",
            prompt: "check status",
            intervalMinutes: 15,
            nextRunAt: "2026-05-09T00:15:00.000Z",
            lastRunAt: null,
            lastError: null,
            createdAt: state.updatedAt,
            updatedAt: state.updatedAt,
        });
        await writeBridgeState(fixture.statePath, state);
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc run-now job_1"));
        await router.handleUpdate(update("123", "456", "/oc unschedule job_1"));

        const read = await readBridgeState(fixture.statePath);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_abc", text: "check status" }]);
        assert.deepEqual(read.jobs, []);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), [
            "*\\[bridge\\]* ran scheduled job `job_1` for `ses_abc`",
            "*\\[bridge\\]* unscheduled `job_1`",
        ]);
    });

    it("routes permission decisions to OpenCode", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "telegram:456:", platform: "telegram", surface: { chatID: "456", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        await writeBridgeState(fixture.statePath, state);
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc allow per_once"));
        await router.handleUpdate(update("123", "456", "/oc always per_always"));
        await router.handleUpdate(update("123", "456", "/oc deny per_reject too risky"));

        assert.deepEqual(fixture.opencode.permissionReplies, [
            { sessionID: "ses_abc", permissionID: "per_once", response: "once" },
            { sessionID: "ses_abc", permissionID: "per_always", response: "always" },
            { sessionID: "ses_abc", permissionID: "per_reject", response: "reject", message: "too risky" },
        ]);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), [
            "*\\[bridge\\]* permission `once` sent for `per_once`",
            "*\\[bridge\\]* permission `always` sent for `per_always`",
            "*\\[bridge\\]* permission `reject` sent for `per_reject`",
        ]);
    });

    it("rejects permission commands without a permission ID", async () => {
        const fixture = await createFixture();
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc allow"));

        assert.deepEqual(fixture.opencode.permissionReplies, []);
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["*\\[bridge\\]* permission ID is required"]);
    });

    it("keeps reactions best-effort so Telegram reaction errors do not block commands", async () => {
        const fixture = await createFixture({ failReactions: true });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc status"));

        assert.equal(fixture.opencode.healthCalls, 1);
        assert.equal(fixture.telegram.messages.length, 1);
    });
});

interface FixtureOptions {
    sessions?: OpenCodeSession[];
    createdSession?: OpenCodeSession;
    createTopics?: boolean;
    topic?: TelegramForumTopic;
    failTopicCreation?: boolean;
    failReactions?: boolean;
    voiceEnabled?: boolean;
    transcriptionText?: string;
    intentResolverEnabled?: boolean;
    workspaceRoot?: string;
    resolverOutputs?: IntentResolverRunFixture[];
}

interface IntentResolverRunFixture {
    resolverSessionID: string;
    output: IntentResolverOutput;
}

interface FakeOpenCode {
    healthCalls: number;
    createdTitles: string[];
    createdSessions: Array<{ title?: string; directory?: string }>;
    prompts: Array<{ sessionID: string; text: string; directory?: string }>;
    permissionReplies: Array<{ sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string }>;
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number }): Promise<OpenCodeSession[]>;
    getSession(input: { sessionID: string }): Promise<OpenCodeSession>;
    createSession(input?: { title?: string; directory?: string }): Promise<OpenCodeSession>;
    sendPrompt(input: { sessionID: string; text: string; directory?: string }): Promise<void>;
    abortSession(input: { sessionID: string }): Promise<void>;
    replyPermission(input: { sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string }): Promise<void>;
}

interface FakeIntentResolver {
    starts: Array<{ text: string; workspaceRoot: string }>;
    continuations: Array<{ resolverSessionID: string; answer: string; workspaceRoot: string }>;
    start(input: { text: string; workspaceRoot: string }): Promise<IntentResolverRunFixture>;
    continue(input: { resolverSessionID: string; answer: string; workspaceRoot: string }): Promise<IntentResolverRunFixture>;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    statePath: string;
    dependencies: ConstructorParameters<typeof TelegramBridgeRouter>[0];
    telegram: {
        messages: SendMessageInput[];
        actions: SendChatActionInput[];
        reactions: SetMessageReactionInput[];
        callbackAnswers: AnswerCallbackQueryInput[];
        topics: CreateForumTopicInput[];
        fileRequests: Array<{ fileID: string }>;
        downloads: Array<{ filePath: string }>;
    };
    opencode: FakeOpenCode;
    resolver: FakeIntentResolver;
    transcriber: FakeTranscriber;
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-router-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const telegram = {
        messages: [] as SendMessageInput[],
        actions: [] as SendChatActionInput[],
        reactions: [] as SetMessageReactionInput[],
        callbackAnswers: [] as AnswerCallbackQueryInput[],
        topics: [] as CreateForumTopicInput[],
        fileRequests: [] as Array<{ fileID: string }>,
        downloads: [] as Array<{ filePath: string }>,
        async sendMessage(input: SendMessageInput): Promise<void> {
            telegram.messages.push(input);
        },
        async sendChatAction(input: SendChatActionInput): Promise<void> {
            telegram.actions.push(input);
        },
        async setMessageReaction(input: SetMessageReactionInput): Promise<void> {
            if (options.failReactions) {
                throw new Error("reaction failed");
            }

            telegram.reactions.push(input);
        },
        async answerCallbackQuery(input: AnswerCallbackQueryInput): Promise<void> {
            telegram.callbackAnswers.push(input);
        },
        async createForumTopic(input: CreateForumTopicInput): Promise<TelegramForumTopic> {
            telegram.topics.push(input);
            if (options.failTopicCreation) {
                throw new Error("topic creation failed");
            }

            return options.topic ?? { messageThreadID: "777", name: input.name, iconColor: 7322096, iconCustomEmojiID: null, isNameImplicit: false };
        },
        async getFile(input: { fileID: string }): Promise<{ fileID: string; uniqueID: string; size: number | null; path: string }> {
            telegram.fileRequests.push(input);

            return { fileID: input.fileID, uniqueID: "unique-file", size: 3, path: "voice/file.ogg" };
        },
        async downloadFile(input: { filePath: string }): Promise<Uint8Array> {
            telegram.downloads.push(input);

            return new Uint8Array([1, 2, 3]);
        },
    };
    const transcriber: FakeTranscriber = {
        transcriptions: [],
        async transcribe(input: { data: Uint8Array; format: OpenRouterAudioFormat }): Promise<TranscriptionResult> {
            transcriber.transcriptions.push({ data: Array.from(input.data), format: input.format });

            return { text: options.transcriptionText ?? "transcribed text" };
        },
    };
    const opencode: FakeOpenCode = {
        healthCalls: 0,
        createdTitles: [],
        createdSessions: [],
        prompts: [],
        permissionReplies: [],
        async health(): Promise<OpenCodeHealth> {
            opencode.healthCalls += 1;
            return { healthy: true, version: "1.3.17" };
        },
        async listSessions(): Promise<OpenCodeSession[]> {
            return options.sessions ?? [];
        },
        async getSession(input: { sessionID: string }): Promise<OpenCodeSession> {
            return options.sessions?.find((session) => session.id === input.sessionID) ?? { id: input.sessionID, title: null, directory: null, time: null };
        },
        async createSession(input: { title?: string; directory?: string } = {}): Promise<OpenCodeSession> {
            opencode.createdTitles.push(input.title ?? "");
            opencode.createdSessions.push(input);
            return options.createdSession ?? { id: "ses_new", title: input.title ?? null, directory: input.directory ?? null, time: null };
        },
        async sendPrompt(input: { sessionID: string; text: string; directory?: string }): Promise<void> {
            opencode.prompts.push(input);
        },
        async abortSession(): Promise<void> {
            return undefined;
        },
        async replyPermission(input: { sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string }): Promise<void> {
            opencode.permissionReplies.push(input);
        },
    };
    const resolver: FakeIntentResolver = {
        starts: [],
        continuations: [],
        async start(input: { text: string; workspaceRoot: string }): Promise<IntentResolverRunFixture> {
            resolver.starts.push(input);
            return nextResolverOutput(options);
        },
        async continue(input: { resolverSessionID: string; answer: string; workspaceRoot: string }): Promise<IntentResolverRunFixture> {
            resolver.continuations.push(input);
            return nextResolverOutput(options);
        },
    };

    return {
        statePath,
        dependencies: {
            config: bridgeConfig(statePath, options),
            telegram,
            opencode,
            intentResolver: resolver,
            transcriber,
            now: () => new Date("2026-05-09T00:00:00.000Z"),
        },
        telegram,
        opencode,
        resolver,
        transcriber,
    };
}

function bridgeConfig(statePath: string, options: FixtureOptions = {}): BridgeConfig {
    return {
        opencode: {
            baseUrl: "http://127.0.0.1:4096",
            process: {
                manage: false,
                command: "opencode",
                host: "127.0.0.1",
                port: 4096,
                workdir: null,
                startupTimeoutMs: 30000,
            },
        },
        statePath,
        implicitReply: false,
        telegram: {
            enabled: true,
            botToken: "bot-token",
            allowedUserIDs: ["123"],
            allowedChatIDs: [],
            createTopics: options.createTopics ?? false,
        },
        discord: {
            enabled: false,
            botToken: null,
            applicationID: null,
            guildID: null,
            allowedUserIDs: [],
            controlChannelID: null,
            prefix: "!oc",
            slashCommand: "oc",
            registerSlashCommands: false,
            slashResponsesEphemeral: true,
            messageContentIntent: false,
            maxMessageChars: 1850,
        },
        workspace: {
            root: options.workspaceRoot ?? null,
        },
        intentResolver: {
            enabled: options.intentResolverEnabled ?? false,
            maxClarificationTurns: 4,
            clarificationTtlMs: 600000,
        },
        voice: {
            enabled: options.voiceEnabled ?? false,
            maxAudioBytes: 20971520,
            openrouter: {
                apiKey: options.voiceEnabled ? "openrouter-key" : null,
                baseUrl: "https://openrouter.ai/api/v1",
                model: "openai/whisper-1",
                language: null,
            },
        },
    };
}

function nextResolverOutput(options: FixtureOptions): IntentResolverRunFixture {
    const output = options.resolverOutputs?.shift();
    if (!output) {
        throw new Error("No fake resolver output configured");
    }

    return output;
}

function update(userID: string, chatID: string, text: string, threadID: string | null = null, chatType?: string): TelegramUpdate {
    const message = {
        messageID: 10,
        threadID,
        userID,
        chatID,
        text,
    };

    if (chatType) {
        return {
            updateID: 1,
            message: { ...message, chatType },
        };
    }

    return {
        updateID: 1,
        message,
    };
}

function callbackUpdate(userID: string, chatID: string, callbackQueryID: string, data: string, threadID: string | null = null): TelegramUpdate {
    return {
        updateID: 1,
        message: null,
        callbackQuery: {
            id: callbackQueryID,
            userID,
            message: {
                messageID: 99,
                threadID,
                userID: null,
                chatID,
                text: "Which repository?",
            },
            data,
        },
    };
}

function voiceUpdate(
    userID: string,
    chatID: string,
    audio: { fileID: string; mimeType: string | null; fileSize: number | null },
): TelegramUpdate {
    return {
        updateID: 1,
        message: {
            messageID: 10,
            threadID: null,
            userID,
            chatID,
            text: null,
            audio: {
                kind: "voice",
                fileID: audio.fileID,
                fileName: null,
                fileSize: audio.fileSize,
                mimeType: audio.mimeType,
            },
        },
    };
}

interface FakeTranscriber {
    transcriptions: Array<{ data: number[]; format: OpenRouterAudioFormat }>;
    transcribe(input: { data: Uint8Array; format: OpenRouterAudioFormat }): Promise<TranscriptionResult>;
}

function pendingResolverState(input: { id: string; allowFreeText: boolean }) {
    return {
        id: input.id,
        platform: "telegram" as const,
        surfaceID: "telegram:456:",
        surface: { chatID: "456", threadID: null },
        userID: "123",
        resolverSessionID: "ses_resolver",
        workspaceRoot: "/workspace/dev",
        originalText: "work on api",
        turnCount: 1,
        maxTurns: 4,
        expiresAt: "2026-05-09T00:10:00.000Z",
        lastQuestion: "Which repository?",
        allowFreeText: input.allowFreeText,
        options: [
            { id: "repo-api", label: "api", value: "api" },
        ],
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-09T00:00:00.000Z",
    };
}
