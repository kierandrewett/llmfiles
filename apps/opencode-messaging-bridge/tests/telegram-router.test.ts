import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { type BridgeConfig } from "../src/config.js";
import { type OpenCodeHealth, type OpenCodeSession } from "../src/opencode.js";
import { readBridgeState, writeBridgeState, createDefaultBridgeState } from "../src/state.js";
import { TelegramBridgeRouter } from "../src/telegram-router.js";
import {
    TELEGRAM_MARKDOWN_PARSE_MODE,
    type CreateForumTopicInput,
    type SendChatActionInput,
    type SendMessageInput,
    type SetMessageReactionInput,
    type TelegramForumTopic,
    type TelegramUpdate,
} from "../src/telegram.js";

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
}

interface FakeOpenCode {
    healthCalls: number;
    createdTitles: string[];
    prompts: Array<{ sessionID: string; text: string }>;
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number }): Promise<OpenCodeSession[]>;
    getSession(input: { sessionID: string }): Promise<OpenCodeSession>;
    createSession(input?: { title?: string }): Promise<OpenCodeSession>;
    sendPrompt(input: { sessionID: string; text: string }): Promise<void>;
    abortSession(input: { sessionID: string }): Promise<void>;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    statePath: string;
    dependencies: ConstructorParameters<typeof TelegramBridgeRouter>[0];
    telegram: {
        messages: SendMessageInput[];
        actions: SendChatActionInput[];
        reactions: SetMessageReactionInput[];
        topics: CreateForumTopicInput[];
    };
    opencode: FakeOpenCode;
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-router-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const telegram = {
        messages: [] as SendMessageInput[],
        actions: [] as SendChatActionInput[],
        reactions: [] as SetMessageReactionInput[],
        topics: [] as CreateForumTopicInput[],
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
        async createForumTopic(input: CreateForumTopicInput): Promise<TelegramForumTopic> {
            telegram.topics.push(input);
            if (options.failTopicCreation) {
                throw new Error("topic creation failed");
            }

            return options.topic ?? { messageThreadID: "777", name: input.name, iconColor: 7322096, iconCustomEmojiID: null, isNameImplicit: false };
        },
    };
    const opencode: FakeOpenCode = {
        healthCalls: 0,
        createdTitles: [],
        prompts: [],
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
        async createSession(input: { title?: string } = {}): Promise<OpenCodeSession> {
            opencode.createdTitles.push(input.title ?? "");
            return options.createdSession ?? { id: "ses_new", title: input.title ?? null, directory: null, time: null };
        },
        async sendPrompt(input: { sessionID: string; text: string }): Promise<void> {
            opencode.prompts.push(input);
        },
        async abortSession(): Promise<void> {
            return undefined;
        },
    };

    return {
        statePath,
        dependencies: {
            config: bridgeConfig(statePath, options),
            telegram,
            opencode,
            now: () => new Date("2026-05-09T00:00:00.000Z"),
        },
        telegram,
        opencode,
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
    };
}

function update(userID: string, chatID: string, text: string, threadID: string | null = null, chatType?: string): TelegramUpdate {
    return {
        updateID: 1,
        message: {
            messageID: 10,
            threadID,
            userID,
            chatID,
            chatType,
            text,
        },
    };
}
