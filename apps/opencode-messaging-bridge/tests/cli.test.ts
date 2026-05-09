import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { OpenCodeHealth, OpenCodeSession } from "../src/opencode.js";

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

    it("prints recent sessions", async () => {
        const { env, output, client } = await createFixture({ sessions: [{ id: "ses_abc", title: "Example", directory: null, time: null }] });

        const exitCode = await runCli(["sessions"], { env, stdout: output.stdout, stderr: output.stderr, client });

        assert.equal(exitCode, 0);
        assert.deepEqual(output.lines, ["ses_abc\tExample"]);
    });

    it("creates a session", async () => {
        const { env, output, client } = await createFixture({ createdSession: { id: "ses_new", title: "New session", directory: null, time: null } });

        const exitCode = await runCli(["new", "New", "session"], { env, stdout: output.stdout, stderr: output.stderr, client });

        assert.equal(exitCode, 0);
        assert.deepEqual(output.lines, ["[bridge] created session ses_new\tNew session"]);
    });
});

interface FixtureOptions {
    health?: OpenCodeHealth;
    sessions?: OpenCodeSession[];
    createdSession?: OpenCodeSession;
}

interface FixtureClient {
    health(): Promise<OpenCodeHealth>;
    listSessions(): Promise<OpenCodeSession[]>;
    createSession(input: { title?: string }): Promise<OpenCodeSession>;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    env: Record<string, string>;
    output: { lines: string[]; errors: string[]; stdout(line: string): void; stderr(line: string): void };
    client: FixtureClient;
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
    };
}
