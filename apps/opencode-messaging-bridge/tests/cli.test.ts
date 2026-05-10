import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { OpenCodeHealth, OpenCodeSession } from "../src/opencode.js";

const TELEGRAM_DISABLED_ERROR = "[bridge] Telegram bridge is not enabled. "
    + "Set OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN and OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS.";
const DISCORD_DISABLED_ERROR = "[bridge] Discord bridge is not enabled. "
    + "Set OPENCODE_BRIDGE_DISCORD_BOT_TOKEN, OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID, and OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS.";
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("runCli", () => {
    it("prints OpenCode status", async () => {
        const { env, output, client } = await createFixture();

        const exitCode = await runCli(["status"], { env, stdout: output.stdout, stderr: output.stderr, client });

        assert.equal(exitCode, 0);
        assert.deepEqual(output.lines, [
            "[bridge] OpenCode healthy: true",
            "[bridge] OpenCode version: 1.3.17",
            `[bridge] state: ${env.OPENCODE_BRIDGE_STATE_PATH}`,
        ]);
    });

    it("starts and stops the managed OpenCode process around OpenCode commands", async () => {
        const { env, output, client, processManager } = await createFixture();
        env.OPENCODE_BRIDGE_MANAGE_OPENCODE = "1";

        const exitCode = await runCli(
            ["status"],
            { env, stdout: output.stdout, stderr: output.stderr, client, processManager },
        );

        assert.equal(exitCode, 0);
        assert.deepEqual(processManager.calls, ["start", "stop"]);
    });

    it("stops the managed OpenCode process when an OpenCode command fails", async () => {
        const { env, output, processManager } = await createFixture();
        env.OPENCODE_BRIDGE_MANAGE_OPENCODE = "1";

        const exitCode = await runCli(
            ["status"],
            {
                env,
                stdout: output.stdout,
                stderr: output.stderr,
                client: {
                    async health(): Promise<OpenCodeHealth> {
                        throw new Error("health failed");
                    },
                    async listSessions(): Promise<OpenCodeSession[]> {
                        return [];
                    },
                    async createSession(): Promise<OpenCodeSession> {
                        return { id: "ses_new", title: null, directory: null, time: null };
                    },
                },
                processManager,
            },
        );

        assert.equal(exitCode, 1);
        assert.deepEqual(processManager.calls, ["start", "stop"]);
        assert.deepEqual(output.errors, ["[bridge] health failed"]);
    });

    it("prints recent sessions", async () => {
        const { env, output, client } = await createFixture({
            sessions: [{ id: "ses_abc", title: "Example", directory: null, time: null }],
        });

        const exitCode = await runCli(["sessions"], { env, stdout: output.stdout, stderr: output.stderr, client });

        assert.equal(exitCode, 0);
        assert.deepEqual(output.lines, ["ses_abc\tExample"]);
    });

    it("creates a session", async () => {
        const { env, output, client } = await createFixture({
            createdSession: { id: "ses_new", title: "New session", directory: null, time: null },
        });

        const exitCode = await runCli(["new", "New", "session"], { env, stdout: output.stdout, stderr: output.stderr, client });

        assert.equal(exitCode, 0);
        assert.deepEqual(output.lines, ["[bridge] created session ses_new\tNew session"]);
    });

    it("runs one Telegram polling cycle when Telegram is configured", async () => {
        const { env, output, telegramPoller } = await createFixture({ telegramProcessed: 2 });

        env.OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN = "telegram-token";
        env.OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS = "123";

        const exitCode = await runCli(
            ["telegram-once"],
            { env, stdout: output.stdout, stderr: output.stderr, telegramPoller },
        );

        assert.equal(exitCode, 0);
        assert.equal(telegramPoller.calls, 1);
        assert.deepEqual(output.lines, ["[bridge] telegram processed 2 update(s)"]);
    });

    it("refuses Telegram polling when Telegram is not configured", async () => {
        const { env, output, telegramPoller } = await createFixture();

        const exitCode = await runCli(
            ["telegram-once"],
            { env, stdout: output.stdout, stderr: output.stderr, telegramPoller },
        );

        assert.equal(exitCode, 1);
        assert.equal(telegramPoller.calls, 0);
        assert.deepEqual(output.errors, [TELEGRAM_DISABLED_ERROR]);
    });

    it("runs one Discord Gateway cycle when Discord is configured", async () => {
        const { env, output, discordGateway } = await createFixture({ discordProcessed: 3 });

        env.OPENCODE_BRIDGE_DISCORD_BOT_TOKEN = "discord-token";
        env.OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS = "123";
        env.OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID = "456";

        const exitCode = await runCli(
            ["discord-once"],
            { env, stdout: output.stdout, stderr: output.stderr, discordGateway },
        );

        assert.equal(exitCode, 0);
        assert.equal(discordGateway.calls, 1);
        assert.deepEqual(output.lines, ["[bridge] discord processed 3 gateway dispatch event(s)"]);
    });

    it("runs one Telegram poll and one Discord Gateway cycle when both surfaces are configured", async () => {
        const { env, output, telegramPoller, discordGateway } = await createFixture({
            telegramProcessed: 2,
            discordProcessed: 3,
        });

        env.OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN = "telegram-token";
        env.OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS = "123";
        env.OPENCODE_BRIDGE_DISCORD_BOT_TOKEN = "discord-token";
        env.OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS = "123";
        env.OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID = "456";

        const exitCode = await runCli(
            ["telegram+discord-once"],
            { env, stdout: output.stdout, stderr: output.stderr, telegramPoller, discordGateway },
        );

        assert.equal(exitCode, 0);
        assert.equal(telegramPoller.calls, 1);
        assert.equal(discordGateway.calls, 1);
        assert.deepEqual(output.lines, [
            "[bridge] telegram processed 2 update(s)",
            "[bridge] discord processed 3 gateway dispatch event(s)",
        ]);
    });

    it("runs due scheduled prompts once", async () => {
        const { env, output, scheduledPromptRunner } = await createFixture({ scheduledJobsProcessed: 2 });

        const exitCode = await runCli(
            ["automation-once"],
            { env, stdout: output.stdout, stderr: output.stderr, scheduledPromptRunner },
        );

        assert.equal(exitCode, 0);
        assert.equal(scheduledPromptRunner.calls, 1);
        assert.deepEqual(output.lines, ["[bridge] automation processed 2 scheduled job(s)"]);
    });

    it("refuses Discord Gateway when Discord is not configured", async () => {
        const { env, output, discordGateway } = await createFixture();

        const exitCode = await runCli(
            ["discord-once"],
            { env, stdout: output.stdout, stderr: output.stderr, discordGateway },
        );

        assert.equal(exitCode, 1);
        assert.equal(discordGateway.calls, 0);
        assert.deepEqual(output.errors, [DISCORD_DISABLED_ERROR]);
    });
});

interface FixtureOptions {
    health?: OpenCodeHealth;
    sessions?: OpenCodeSession[];
    createdSession?: OpenCodeSession;
    telegramProcessed?: number;
    discordProcessed?: number;
    scheduledJobsProcessed?: number;
}

interface FixtureClient {
    health(): Promise<OpenCodeHealth>;
    listSessions(): Promise<OpenCodeSession[]>;
    createSession(input: { title?: string }): Promise<OpenCodeSession>;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    env: Record<string, string>;
    output: {
        lines: string[];
        errors: string[];
        stdout(line: string): void;
        stderr(line: string): void;
    };
    client: FixtureClient;
    telegramPoller: { calls: number; runOnce(): Promise<number> };
    discordGateway: { calls: number; runOnce(): Promise<number> };
    scheduledPromptRunner: { calls: number; runDueJobs(): Promise<number> };
    processManager: { calls: string[]; start(): Promise<string>; stop(): Promise<void> };
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-bridge-cli-test-"));
    tempDirs.push(dir);
    const output = {
        lines: [] as string[],
        errors: [] as string[],
        stdout(line: string): void {
            output.lines.push(line);
        },
        stderr(line: string): void {
            output.errors.push(line);
        },
    };

    return {
        env: {
            HOME: dir,
            OPENCODE_BRIDGE_STATE_PATH: path.join(dir, "state.json"),
        },
        output,
        client: {
            async health(): Promise<OpenCodeHealth> {
                return options.health ?? { healthy: true, version: "1.3.17" };
            },
            async listSessions(): Promise<OpenCodeSession[]> {
                return options.sessions ?? [];
            },
            async createSession(): Promise<OpenCodeSession> {
                return options.createdSession ?? { id: "ses_new", title: null, directory: null, time: null };
            },
        },
        telegramPoller: {
            calls: 0,
            async runOnce(): Promise<number> {
                this.calls += 1;
                return options.telegramProcessed ?? 0;
            },
        },
        discordGateway: {
            calls: 0,
            async runOnce(): Promise<number> {
                this.calls += 1;
                return options.discordProcessed ?? 0;
            },
        },
        scheduledPromptRunner: {
            calls: 0,
            async runDueJobs(): Promise<number> {
                this.calls += 1;
                return options.scheduledJobsProcessed ?? 0;
            },
        },
        processManager: {
            calls: [] as string[],
            async start(): Promise<string> {
                this.calls.push("start");
                return "http://127.0.0.1:4096";
            },
            async stop(): Promise<void> {
                this.calls.push("stop");
            },
        },
    };
}
