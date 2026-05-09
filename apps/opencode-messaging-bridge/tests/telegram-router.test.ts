import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { type BridgeConfig } from "../src/config.js";
import { type OpenCodeHealth, type OpenCodeSession } from "../src/opencode.js";
import { readBridgeState, writeBridgeState, createDefaultBridgeState } from "../src/state.js";
import { TelegramBridgeRouter } from "../src/telegram-router.js";
import type { SendChatActionInput, SendMessageInput, TelegramUpdate } from "../src/telegram.js";

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
            "[bridge] OpenCode healthy: true\n[bridge] OpenCode version: 1.3.17\n[bridge] active session: none",
        ]);
    });

    it("lists recent sessions", async () => {
        const fixture = await createFixture({ sessions: [{ id: "ses_abc", title: "Example", directory: null, time: null }] });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc sessions"));

        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["ses_abc\tExample"]);
    });

    it("attaches the latest session and persists the binding", async () => {
        const fixture = await createFixture({ sessions: [{ id: "ses_abc", title: "Example", directory: "/tmp/project", time: null }] });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc attach latest", "42"));

        const state = await readBridgeState(fixture.statePath);
        assert.equal(state.surfaces[0]?.id, "telegram:456:42");
        assert.equal(state.surfaces[0]?.activeSessionID, "ses_abc");
        assert.equal(state.bindings[0]?.sessionID, "ses_abc");
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["[bridge] attached ses_abc\tExample"]);
    });

    it("creates a session and binds it to the Telegram surface", async () => {
        const fixture = await createFixture({ createdSession: { id: "ses_new", title: "New work", directory: null, time: null } });
        const router = new TelegramBridgeRouter(fixture.dependencies);

        await router.handleUpdate(update("123", "456", "/oc new New work"));

        const state = await readBridgeState(fixture.statePath);
        assert.deepEqual(fixture.opencode.createdTitles, ["New work"]);
        assert.equal(state.surfaces[0]?.activeSessionID, "ses_new");
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["[bridge] created and attached ses_new\tNew work"]);
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
        assert.deepEqual(fixture.telegram.messages.map((message) => message.text), ["[bridge] prompt sent to ses_abc"]);
    });
});

interface FixtureOptions {
    sessions?: OpenCodeSession[];
    createdSession?: OpenCodeSession;
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
    telegram: { messages: SendMessageInput[]; actions: SendChatActionInput[] };
    opencode: FakeOpenCode;
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-router-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const telegram = {
        messages: [] as SendMessageInput[],
        actions: [] as SendChatActionInput[],
        async sendMessage(input: SendMessageInput): Promise<void> {
            telegram.messages.push(input);
        },
        async sendChatAction(input: SendChatActionInput): Promise<void> {
            telegram.actions.push(input);
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
            config: bridgeConfig(statePath),
            telegram,
            opencode,
            now: () => new Date("2026-05-09T00:00:00.000Z"),
        },
        telegram,
        opencode,
    };
}

function bridgeConfig(statePath: string): BridgeConfig {
    return {
        opencode: { baseUrl: "http://127.0.0.1:4096" },
        statePath,
        implicitReply: false,
        telegram: {
            enabled: true,
            botToken: "bot-token",
            allowedUserIDs: ["123"],
            allowedChatIDs: [],
        },
        discord: {
            enabled: false,
            botToken: null,
            applicationID: null,
            allowedUserIDs: [],
            controlChannelID: null,
        },
    };
}

function update(userID: string, chatID: string, text: string, threadID: string | null = null): TelegramUpdate {
    return {
        updateID: 1,
        message: {
            messageID: 10,
            threadID,
            userID,
            chatID,
            text,
        },
    };
}
