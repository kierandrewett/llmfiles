import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createDefaultBridgeState, loadOrCreateBridgeState, readBridgeState, writeBridgeState } from "../src/state.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("createDefaultBridgeState", () => {
    it("does not store secret or runtime config values", () => {
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));

        assert.equal(state.version, 1);
        assert.equal(state.updatedAt, "2026-05-09T00:00:00.000Z");
        assert.deepEqual(Object.keys(state.platforms), ["telegram", "discord"]);
        assert.deepEqual(state.jobs, []);
        assert.deepEqual(state.intentResolvers, []);
        assert.equal(JSON.stringify(state).includes("baseUrl"), false);
        assert.equal(JSON.stringify(state).includes("token"), false);
    });
});

describe("BridgeStateStore", () => {
    it("creates a default state file when one does not exist", async () => {
        const dir = await createTempDir();
        const filePath = path.join(dir, "nested", "state.json");

        const state = await loadOrCreateBridgeState(filePath, new Date("2026-05-09T00:00:00.000Z"));
        const raw = await readFile(filePath, "utf8");

        assert.equal(state.version, 1);
        assert.equal(raw.endsWith("\n"), true);
    });

    it("writes and reads routing state", async () => {
        const dir = await createTempDir();
        const filePath = path.join(dir, "state.json");
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));

        state.surfaces.push({
            id: "telegram:123:",
            platform: "telegram",
            surface: { chatID: "123", threadID: null },
            activeSessionID: "ses_abc",
            updatedAt: "2026-05-09T00:00:00.000Z",
        });
        state.bindings.push({
            id: "telegram:123:ses_abc",
            platform: "telegram",
            surface: { chatID: "123", threadID: null },
            sessionID: "ses_abc",
            directory: "/home/kieran/dev/lifeos-scrubbed",
            title: "Session title",
            createdAt: "2026-05-09T00:00:00.000Z",
            updatedAt: "2026-05-09T00:00:00.000Z",
        });
        state.intentResolvers.push({
            id: "ir_telegram_123",
            platform: "telegram",
            surfaceID: "telegram:123:",
            surface: { chatID: "123", threadID: null },
            userID: "123",
            resolverSessionID: "ses_resolver",
            workspaceRoot: "/workspace/dev",
            originalText: "work on bsociety",
            turnCount: 1,
            maxTurns: 4,
            expiresAt: "2026-05-09T00:10:00.000Z",
            lastQuestion: "Which repository do you mean?",
            allowFreeText: false,
            options: [
                { id: "repo-bsociety", label: "bsociety", value: "bsociety" },
            ],
            createdAt: "2026-05-09T00:00:00.000Z",
            updatedAt: "2026-05-09T00:00:00.000Z",
        });

        await writeBridgeState(filePath, state);
        const read = await readBridgeState(filePath);

        assert.deepEqual(read, state);
    });

    it("rejects unsupported state versions", async () => {
        const dir = await createTempDir();
        const filePath = path.join(dir, "state.json");

        await writeFile(filePath, JSON.stringify({ version: 99 }), "utf8");

        await assert.rejects(() => readBridgeState(filePath), /Unsupported bridge state version/);
    });

    it("loads pre-automation state files without scheduled jobs", async () => {
        const dir = await createTempDir();
        const filePath = path.join(dir, "state.json");
        const legacyState = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z")) as unknown as Record<string, unknown>;
        delete legacyState.jobs;
        await writeFile(filePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

        const read = await readBridgeState(filePath);

        assert.deepEqual(read.jobs, []);
    });

    it("loads pre-resolver state files without pending resolver sessions", async () => {
        const dir = await createTempDir();
        const filePath = path.join(dir, "state.json");
        const legacyState = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z")) as unknown as Record<string, unknown>;
        delete legacyState.intentResolvers;
        await writeFile(filePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

        const read = await readBridgeState(filePath);

        assert.deepEqual(read.intentResolvers, []);
    });
});

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-bridge-test-"));
    tempDirs.push(dir);
    return dir;
}
