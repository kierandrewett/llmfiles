import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createDefaultBridgeState, writeBridgeState } from "../src/state.js";
import { TelegramEventRelay } from "../src/telegram-event-relay.js";
import type { OpenCodeEvent } from "../src/opencode.js";
import type { SendMessageInput } from "../src/telegram.js";

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

        assert.deepEqual(fixture.telegram.sent, [
            { chatID: "456", threadID: null, text: "hello world" },
        ]);
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

        assert.deepEqual(fixture.telegram.sent, [
            { chatID: "456", threadID: null, text: "hello" },
        ]);
    });
});

async function createFixture(): Promise<{
    dependencies: ConstructorParameters<typeof TelegramEventRelay>[0];
    telegram: { sent: SendMessageInput[] };
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-event-relay-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
    state.bindings.push({
        id: "telegram:456::ses_abc",
        platform: "telegram",
        surface: { chatID: "456", threadID: null },
        sessionID: "ses_abc",
        directory: null,
        title: "Example",
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-09T00:00:00.000Z",
    });
    await writeBridgeState(statePath, state);

    const telegram = {
        sent: [] as SendMessageInput[],
        async sendMessage(input: SendMessageInput): Promise<void> {
            telegram.sent.push(input);
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
