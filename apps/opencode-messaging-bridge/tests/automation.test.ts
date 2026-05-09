import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { parseScheduleArgs, ScheduledPromptRunner } from "../src/automation.js";
import { createDefaultBridgeState, readBridgeState, writeBridgeState, type BridgeScheduledJobState } from "../src/state.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("parseScheduleArgs", () => {
    it("parses explicit interval schedules", () => {
        assert.deepEqual(parseScheduleArgs(["every", "15m", "check", "status"]), {
            ok: true,
            intervalMinutes: 15,
            prompt: "check status",
        });
        assert.deepEqual(parseScheduleArgs(["every", "2h", "write", "summary"]), {
            ok: true,
            intervalMinutes: 120,
            prompt: "write summary",
        });
    });

    it("rejects unsafe or incomplete schedules", () => {
        assert.deepEqual(parseScheduleArgs(["15m", "check"]), {
            ok: false,
            message: "schedule syntax is every <duration> <prompt>",
        });
        assert.deepEqual(parseScheduleArgs(["every", "1m", "too", "often"]), {
            ok: false,
            message: "duration must be between 5m and 7d",
        });
        assert.deepEqual(parseScheduleArgs(["every", "15m"]), {
            ok: false,
            message: "prompt text is required",
        });
    });
});

describe("ScheduledPromptRunner", () => {
    it("sends due scheduled prompts and records the next run", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.jobs.push(job({ nextRunAt: "2026-05-09T00:00:00.000Z" }));
        await writeBridgeState(fixture.statePath, state);
        const runner = new ScheduledPromptRunner({
            statePath: fixture.statePath,
            opencode: fixture.opencode,
            now: () => new Date("2026-05-09T00:10:00.000Z"),
        });

        const processed = await runner.runDueJobs();

        const read = await readBridgeState(fixture.statePath);
        assert.equal(processed, 1);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_abc", text: "check status" }]);
        assert.equal(read.jobs[0]?.lastRunAt, "2026-05-09T00:10:00.000Z");
        assert.equal(read.jobs[0]?.lastError, null);
        assert.equal(read.jobs[0]?.nextRunAt, "2026-05-09T00:40:00.000Z");
    });

    it("ignores scheduled prompts that are not due yet", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.jobs.push(job({ nextRunAt: "2026-05-09T00:30:00.000Z" }));
        await writeBridgeState(fixture.statePath, state);
        const runner = new ScheduledPromptRunner({
            statePath: fixture.statePath,
            opencode: fixture.opencode,
            now: () => new Date("2026-05-09T00:10:00.000Z"),
        });

        const processed = await runner.runDueJobs();

        assert.equal(processed, 0);
        assert.deepEqual(fixture.opencode.prompts, []);
    });

    it("records prompt failures without blocking other jobs", async () => {
        const fixture = await createFixture({ failPrompts: true });
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.jobs.push(job({ nextRunAt: "2026-05-09T00:00:00.000Z" }));
        await writeBridgeState(fixture.statePath, state);
        const runner = new ScheduledPromptRunner({
            statePath: fixture.statePath,
            opencode: fixture.opencode,
            now: () => new Date("2026-05-09T00:10:00.000Z"),
        });

        const processed = await runner.runDueJobs();

        const read = await readBridgeState(fixture.statePath);
        assert.equal(processed, 1);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_abc", text: "check status" }]);
        assert.equal(read.jobs[0]?.lastRunAt, "2026-05-09T00:10:00.000Z");
        assert.equal(read.jobs[0]?.lastError, "OpenCode unavailable");
        assert.equal(read.jobs[0]?.nextRunAt, "2026-05-09T00:40:00.000Z");
    });
});

interface FixtureOptions {
    failPrompts?: boolean;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    statePath: string;
    opencode: { prompts: Array<{ sessionID: string; text: string }>; sendPrompt(input: { sessionID: string; text: string }): Promise<void> };
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-automation-test-"));
    tempDirs.push(dir);
    const opencode = {
        prompts: [] as Array<{ sessionID: string; text: string }>,
        async sendPrompt(input: { sessionID: string; text: string }): Promise<void> {
            opencode.prompts.push(input);
            if (options.failPrompts) {
                throw new Error("OpenCode unavailable");
            }
        },
    };

    return { statePath: path.join(dir, "state.json"), opencode };
}

function job(overrides: Partial<BridgeScheduledJobState> = {}): BridgeScheduledJobState {
    return {
        id: "job_1",
        platform: "telegram",
        surfaceID: "telegram:456:",
        surface: { chatID: "456", threadID: null },
        sessionID: "ses_abc",
        prompt: "check status",
        intervalMinutes: 30,
        nextRunAt: "2026-05-09T00:00:00.000Z",
        lastRunAt: null,
        lastError: null,
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-09T00:00:00.000Z",
        ...overrides,
    };
}
