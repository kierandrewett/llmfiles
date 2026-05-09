import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { DiscordEventRelay } from "../src/discord-event-relay.js";
import type { SendDiscordMessageInput } from "../src/discord.js";
import type { OpenCodeEvent } from "../src/opencode.js";
import { createDefaultBridgeState, writeBridgeState } from "../src/state.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("DiscordEventRelay", () => {
    it("relays text part deltas to every Discord binding for the session", async () => {
        const fixture = await createFixture();
        const relay = new DiscordEventRelay({
            statePath: fixture.statePath,
            discord: fixture.discord,
            flushDelayMs: 1000,
            setTimer: fixture.timers.setTimer,
            clearTimer: fixture.timers.clearTimer,
        });

        await relay.handleEvent(partUpdated("ses_abc", "part_1", "hello", "hello"));
        assert.equal(fixture.discord.messages.length, 0);

        await relay.flushAll();

        assert.deepEqual(fixture.discord.messages, [{ channelID: "channel-id", content: "hello" }]);
    });

    it("ignores text events for unbound sessions", async () => {
        const fixture = await createFixture();
        const relay = new DiscordEventRelay({ statePath: fixture.statePath, discord: fixture.discord });

        await relay.handleEvent(partUpdated("ses_other", "part_1", "hello", "hello"));
        await relay.flushAll();

        assert.deepEqual(fixture.discord.messages, []);
    });

    it("flushes pending text when the session becomes idle", async () => {
        const fixture = await createFixture();
        const relay = new DiscordEventRelay({
            statePath: fixture.statePath,
            discord: fixture.discord,
            flushDelayMs: 1000,
            setTimer: fixture.timers.setTimer,
            clearTimer: fixture.timers.clearTimer,
        });

        await relay.handleEvent(partUpdated("ses_abc", "part_1", "hello", "hello"));
        await relay.handleEvent({ type: "session.idle", properties: { sessionID: "ses_abc" } });

        assert.deepEqual(fixture.discord.messages, [{ channelID: "channel-id", content: "hello" }]);
    });
});

async function createFixture(): Promise<{
    statePath: string;
    discord: { messages: SendDiscordMessageInput[]; sendMessage(input: SendDiscordMessageInput): Promise<void> };
    timers: {
        setTimer(callback: () => void, ms: number): NodeJS.Timeout;
        clearTimer(timer: NodeJS.Timeout): void;
    };
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-discord-relay-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
    state.bindings.push({
        id: "discord:channel-id:ses_abc",
        platform: "discord",
        surface: { channelID: "channel-id", threadID: null },
        sessionID: "ses_abc",
        directory: null,
        title: "Example",
        createdAt: state.updatedAt,
        updatedAt: state.updatedAt,
    });
    await writeBridgeState(statePath, state);

    const discord = {
        messages: [] as SendDiscordMessageInput[],
        async sendMessage(input: SendDiscordMessageInput): Promise<void> {
            discord.messages.push(input);
        },
    };
    const timers = {
        setTimer(): NodeJS.Timeout {
            return setTimeout(() => undefined, 60000);
        },
        clearTimer(timer: NodeJS.Timeout): void {
            clearTimeout(timer);
        },
    };

    return { statePath, discord, timers };
}

function partUpdated(sessionID: string, partID: string, text: string, delta: string): OpenCodeEvent {
    return {
        type: "message.part.updated",
        properties: {
            delta,
            part: {
                id: partID,
                type: "text",
                sessionID,
                text,
            },
        },
    };
}
