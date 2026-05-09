import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createDefaultBridgeState, writeBridgeState } from "../src/state.js";
import { TelegramEventRelay } from "../src/telegram-event-relay.js";
import type { OpenCodeEvent } from "../src/opencode.js";
import {
    TELEGRAM_MARKDOWN_PARSE_MODE,
    type EditMessageTextInput,
    type SendMessageDraftInput,
    type SendMessageInput,
    type TelegramSentMessage,
} from "../src/telegram.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("TelegramEventRelay", () => {
    it("relays text part deltas to every Telegram binding for the session", async () => {
        const fixture = await createFixture();
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(textEvent("ses_abc", "part_1", "hello"));
        await relay.handleEvent(textEvent("ses_abc", "part_1", "hello world"));
        await relay.flushAll();

        assert.deepEqual(fixture.telegram.drafts.map((draft) => draft.text), ["hello world"]);
        assert.deepEqual(fixture.telegram.sent, []);
    });

    it("ignores text events for unbound sessions", async () => {
        const fixture = await createFixture();
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(textEvent("ses_other", "part_1", "hello"));
        await relay.flushAll();

        assert.deepEqual(fixture.telegram.sent, []);
    });

    it("flushes pending text when the session becomes idle", async () => {
        const fixture = await createFixture();
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(textEvent("ses_abc", "part_1", "hello"));
        await relay.handleEvent({ type: "session.idle", properties: { sessionID: "ses_abc" } });

        assert.deepEqual(fixture.telegram.drafts, []);
        assert.deepEqual(fixture.telegram.sent, [
            { chatID: "456", threadID: null, text: "hello", parseMode: TELEGRAM_MARKDOWN_PARSE_MODE },
        ]);
    });

    it("escapes relayed text before sending it through Telegram MarkdownV2", async () => {
        const fixture = await createFixture();
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(textEvent("ses_abc", "part_1", "[bridge] value_1: a+b."));
        await relay.flushAll();

        assert.deepEqual(fixture.telegram.drafts, [
            {
                chatID: "456",
                threadID: null,
                draftID: fixture.telegram.drafts[0]?.draftID,
                text: "\\[bridge\\] value\\_1: a\\+b\\.",
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            },
        ]);
    });

    it("streams private chat drafts before sending the final persisted message", async () => {
        const fixture = await createFixture({ chatType: "private" });
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(textEvent("ses_abc", "part_1", "hello"));
        await relay.flushAll();
        await relay.handleEvent(textEvent("ses_abc", "part_1", "hello world"));
        await relay.flushAll();
        await relay.handleEvent({ type: "session.idle", properties: { sessionID: "ses_abc" } });

        assert.equal(fixture.telegram.drafts.length, 2);
        assert.equal(fixture.telegram.drafts[0]?.draftID, fixture.telegram.drafts[1]?.draftID);
        assert.notEqual(fixture.telegram.drafts[0]?.draftID, 0);
        assert.deepEqual(fixture.telegram.drafts.map((draft) => draft.text), ["hello", "hello world"]);
        assert.deepEqual(fixture.telegram.sent, [
            { chatID: "456", threadID: null, text: "hello world", parseMode: TELEGRAM_MARKDOWN_PARSE_MODE },
        ]);
        assert.deepEqual(fixture.telegram.edits, []);
    });

    it("uses editable messages as the streaming fallback outside private chats", async () => {
        const fixture = await createFixture({ chatType: "supergroup" });
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(textEvent("ses_abc", "part_1", "hello"));
        await relay.flushAll();
        await relay.handleEvent(textEvent("ses_abc", "part_1", "hello world"));
        await relay.handleEvent({ type: "session.idle", properties: { sessionID: "ses_abc" } });

        assert.deepEqual(fixture.telegram.sent, [
            { chatID: "456", threadID: null, text: "hello", parseMode: TELEGRAM_MARKDOWN_PARSE_MODE },
        ]);
        assert.deepEqual(fixture.telegram.edits, [
            { chatID: "456", messageID: 100, text: "hello world", parseMode: TELEGRAM_MARKDOWN_PARSE_MODE },
        ]);
        assert.deepEqual(fixture.telegram.drafts, []);
    });

    it("relays permission requests to Telegram bindings", async () => {
        const fixture = await createFixture();
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(permissionEvent("ses_abc"));

        assert.deepEqual(fixture.telegram.sent, [
            {
                chatID: "456",
                threadID: null,
                text: [
                    "*\\[bridge\\]* permission requested",
                    "*\\[bridge\\]* id: `per_123`",
                    "*\\[bridge\\]* session: `ses_abc`",
                    "*\\[bridge\\]* request: Run bash command",
                    "*\\[bridge\\]* permission: `bash`",
                    "*\\[bridge\\]* pattern: `git status`",
                    "*\\[bridge\\]* reply: `/oc allow per_123`, `/oc always per_123`, or `/oc deny per_123`",
                ].join("\n"),
                parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
            },
        ]);
    });

    it("relays low-noise tool state changes once per state", async () => {
        const fixture = await createFixture();
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(toolEvent("ses_abc", "tool_1", "bash", "running", "git status"));
        await relay.handleEvent(toolEvent("ses_abc", "tool_1", "bash", "running", "git status"));
        await relay.handleEvent(toolEvent("ses_abc", "tool_1", "bash", "completed", "git status"));

        assert.deepEqual(fixture.telegram.sent.map((message) => message.text), [
            "*\\[bridge\\]* tool started: `bash`\n*\\[bridge\\]* detail: git status",
            "*\\[bridge\\]* tool completed: `bash`\n*\\[bridge\\]* detail: git status",
        ]);
    });

    it("relays session errors to Telegram bindings", async () => {
        const fixture = await createFixture();
        const relay = new TelegramEventRelay(fixture.dependencies);

        await relay.handleEvent(sessionErrorEvent("ses_abc"));

        assert.deepEqual(fixture.telegram.sent.map((message) => message.text), [
            "*\\[bridge\\]* session error\n*\\[bridge\\]* session: `ses_abc`\n*\\[bridge\\]* error: ProviderAuthError: missing API key",
        ]);
    });
});

interface FixtureOptions {
    chatType?: "private" | "group" | "supergroup" | "channel";
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    dependencies: ConstructorParameters<typeof TelegramEventRelay>[0];
    telegram: {
        drafts: SendMessageDraftInput[];
        edits: EditMessageTextInput[];
        sent: SendMessageInput[];
    };
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-event-relay-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
    state.bindings.push({
        id: "telegram:456::ses_abc",
        platform: "telegram",
        surface: { chatID: "456", threadID: null, chatType: options.chatType ?? "private" },
        sessionID: "ses_abc",
        directory: null,
        title: "Example",
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-09T00:00:00.000Z",
    });
    await writeBridgeState(statePath, state);

    const telegram = {
        drafts: [] as SendMessageDraftInput[],
        edits: [] as EditMessageTextInput[],
        sent: [] as SendMessageInput[],
        async sendMessageDraft(input: SendMessageDraftInput): Promise<void> {
            telegram.drafts.push(input);
        },
        async editMessageText(input: EditMessageTextInput): Promise<void> {
            telegram.edits.push(input);
        },
        async sendMessage(input: SendMessageInput): Promise<TelegramSentMessage> {
            telegram.sent.push(input);
            return { messageID: 100 + telegram.sent.length - 1 };
        },
    };

    return {
        dependencies: {
            statePath,
            telegram,
            flushDelayMs: 10_000,
        },
        telegram,
    };
}

function textEvent(sessionID: string, partID: string, text: string): OpenCodeEvent {
    return {
        type: "message.part.updated",
        properties: {
            part: {
                id: partID,
                sessionID,
                messageID: "msg_1",
                type: "text",
                text,
            },
        },
    };
}

function permissionEvent(sessionID: string): OpenCodeEvent {
    return {
        type: "permission.updated",
        properties: {
            id: "per_123",
            sessionID,
            type: "bash",
            pattern: "git status",
            title: "Run bash command",
            metadata: {},
            time: { created: 1 },
        },
    };
}

function toolEvent(sessionID: string, partID: string, tool: string, status: "running" | "completed", title: string): OpenCodeEvent {
    return {
        type: "message.part.updated",
        properties: {
            part: {
                id: partID,
                sessionID,
                messageID: "msg_1",
                type: "tool",
                callID: "call_1",
                tool,
                state: {
                    status,
                    title,
                    input: {},
                    output: "",
                    metadata: {},
                    time: { start: 1, end: status === "completed" ? 2 : undefined },
                },
            },
        },
    };
}

function sessionErrorEvent(sessionID: string): OpenCodeEvent {
    return {
        type: "session.error",
        properties: {
            sessionID,
            error: {
                name: "ProviderAuthError",
                data: { message: "missing API key" },
            },
        },
    };
}
