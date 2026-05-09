import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createDefaultBridgeState, readBridgeState, writeBridgeState } from "../src/state.js";
import { TelegramBridgePoller } from "../src/telegram-poller.js";
import { TELEGRAM_BRIDGE_BOT_COMMANDS, type GetUpdatesOptions, type SetMyCommandsInput, type TelegramUpdate } from "../src/telegram.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("TelegramBridgePoller", () => {
    it("polls from the stored offset and advances after each processed update", async () => {
        const fixture = await createFixture([
            update(5, "/oc status"),
            update(6, "/oc sessions"),
        ]);
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.platforms.telegram.updateOffset = 5;
        await writeBridgeState(fixture.statePath, state);
        const poller = new TelegramBridgePoller(fixture.dependencies);

        const processed = await poller.runOnce();
        const updatedState = await readBridgeState(fixture.statePath);

        assert.equal(processed, 2);
        assert.deepEqual(fixture.telegram.commands, [{ commands: TELEGRAM_BRIDGE_BOT_COMMANDS }]);
        assert.deepEqual(fixture.telegram.requests, [{ offset: 5, timeoutSeconds: 30, allowedUpdates: ["message"] }]);
        assert.deepEqual(fixture.router.handledUpdateIDs, [5, 6]);
        assert.equal(updatedState.platforms.telegram.updateOffset, 7);
    });

    it("does not advance the offset when handling an update fails", async () => {
        const fixture = await createFixture([update(5, "/oc status")], { failOnUpdateID: 5 });
        const poller = new TelegramBridgePoller(fixture.dependencies);

        await assert.rejects(() => poller.runOnce(), /router failed/);
        const state = await readBridgeState(fixture.statePath);

        assert.deepEqual(fixture.telegram.commands, [{ commands: TELEGRAM_BRIDGE_BOT_COMMANDS }]);
        assert.equal(state.platforms.telegram.updateOffset, null);
    });

    it("registers Telegram commands only once per poller", async () => {
        const fixture = await createFixture([]);
        const poller = new TelegramBridgePoller(fixture.dependencies);

        await poller.runOnce();
        await poller.runOnce();

        assert.deepEqual(fixture.telegram.commands, [{ commands: TELEGRAM_BRIDGE_BOT_COMMANDS }]);
    });
});

interface FixtureOptions {
    failOnUpdateID?: number;
}

async function createFixture(updates: TelegramUpdate[], options: FixtureOptions = {}): Promise<{
    statePath: string;
    dependencies: ConstructorParameters<typeof TelegramBridgePoller>[0];
    telegram: { commands: SetMyCommandsInput[]; requests: GetUpdatesOptions[] };
    router: { handledUpdateIDs: number[] };
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-poller-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const telegram = {
        commands: [] as SetMyCommandsInput[],
        requests: [] as GetUpdatesOptions[],
        async setMyCommands(input: SetMyCommandsInput): Promise<void> {
            telegram.commands.push(input);
        },
        async getUpdates(request: GetUpdatesOptions): Promise<TelegramUpdate[]> {
            telegram.requests.push(request);
            return updates;
        },
    };
    const router = {
        handledUpdateIDs: [] as number[],
        async handleUpdate(update: TelegramUpdate): Promise<void> {
            if (update.updateID === options.failOnUpdateID) {
                throw new Error("router failed");
            }

            router.handledUpdateIDs.push(update.updateID);
        },
    };

    return {
        statePath,
        dependencies: {
            statePath,
            telegram,
            router,
            now: () => new Date("2026-05-09T00:00:00.000Z"),
        },
        telegram,
        router,
    };
}

function update(updateID: number, text: string): TelegramUpdate {
    return {
        updateID,
        message: {
            messageID: updateID,
            threadID: null,
            userID: "123",
            chatID: "456",
            text,
        },
    };
}
