import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { OpenCodeProcessConfig } from "../src/config.js";
import { OpenCodeProcessManager, type ManagedOpenCodeChildProcess, type SpawnOpenCodeProcess } from "../src/opencode-process.js";
import type { OpenCodeHealth } from "../src/opencode.js";

describe("OpenCodeProcessManager", () => {
    it("does not spawn OpenCode when process management is disabled", async () => {
        const { manager, spawnCalls, healthClient } = createFixture({ manage: false });

        const baseUrl = await manager.start();
        await manager.stop();

        assert.equal(baseUrl, "http://127.0.0.1:4100");
        assert.equal(spawnCalls.length, 0);
        assert.equal(healthClient.calls, 0);
    });

    it("spawns opencode serve and waits for health when process management is enabled", async () => {
        const { manager, spawnCalls, healthClient } = createFixture({ healthResults: [new Error("not ready"), { healthy: true, version: "1.3.17" }] });

        const baseUrl = await manager.start();

        assert.equal(baseUrl, "http://127.0.0.1:4100");
        assert.equal(healthClient.calls, 2);
        assert.equal(spawnCalls.length, 1);
        assert.equal(spawnCalls[0]?.command, "/usr/local/bin/opencode");
        assert.deepEqual(spawnCalls[0]?.args, ["serve", "--hostname", "127.0.0.1", "--port", "4100"]);
        assert.equal(spawnCalls[0]?.options.cwd, "/workspace/project");
        assert.equal(spawnCalls[0]?.options.stdio, "ignore");
    });

    it("stops the managed process with SIGTERM", async () => {
        const { manager, child } = createFixture();

        await manager.start();
        await manager.stop();

        assert.deepEqual(child.signals, ["SIGTERM"]);
    });

    it("escalates to SIGKILL when the child process does not exit after SIGTERM", async () => {
        const { manager, child } = createFixture({ childExitsOnKill: false });

        await manager.start();
        await manager.stop();

        assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    });

    it("terminates the child process when health does not become ready before the timeout", async () => {
        let now = 0;
        const { manager, child } = createFixture({
            healthResults: [new Error("not ready"), new Error("still not ready"), new Error("timeout")],
            nowMs: () => now,
            sleep: async (ms: number) => {
                now += ms;
            },
            startupTimeoutMs: 500,
        });

        await assert.rejects(
            () => manager.start(),
            /OpenCode did not become healthy within 500ms/,
        );
        assert.deepEqual(child.signals, ["SIGTERM"]);
    });
});

interface SpawnCall {
    command: string;
    args: string[];
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        stdio?: string;
    };
}

interface FixtureOptions {
    manage?: boolean;
    healthResults?: Array<OpenCodeHealth | Error>;
    nowMs?: () => number;
    sleep?: (ms: number) => Promise<void>;
    startupTimeoutMs?: number;
    childExitsOnKill?: boolean;
}

function createFixture(options: FixtureOptions = {}): {
    child: FakeChildProcess;
    manager: OpenCodeProcessManager;
    spawnCalls: SpawnCall[];
    healthClient: { calls: number; health(): Promise<OpenCodeHealth> };
} {
    const child = new FakeChildProcess(options.childExitsOnKill ?? true);
    const spawnCalls: SpawnCall[] = [];
    const healthResults = options.healthResults ?? [{ healthy: true, version: "1.3.17" }];
    const healthClient = {
        calls: 0,
        async health(): Promise<OpenCodeHealth> {
            const result = healthResults[Math.min(healthClient.calls, healthResults.length - 1)]!;
            healthClient.calls += 1;
            if (result instanceof Error) {
                throw result;
            }

            return result;
        },
    };
    const spawn: SpawnOpenCodeProcess = (command, args, spawnOptions) => {
        const callOptions: SpawnCall["options"] = {
            env: spawnOptions.env,
            stdio: spawnOptions.stdio,
        };
        if (spawnOptions.cwd) {
            callOptions.cwd = spawnOptions.cwd;
        }

        spawnCalls.push({
            command,
            args,
            options: callOptions,
        });

        return child;
    };
    const managerDependencies = {
        baseUrl: "http://127.0.0.1:4100",
        process: processConfig(options),
        healthClient,
        spawn,
        sleep: options.sleep ?? (async () => undefined),
    };
    if (options.nowMs) {
        Object.assign(managerDependencies, { nowMs: options.nowMs });
    }

    return {
        child,
        manager: new OpenCodeProcessManager(managerDependencies),
        spawnCalls,
        healthClient,
    };
}

function processConfig(options: FixtureOptions): OpenCodeProcessConfig {
    return {
        manage: options.manage ?? true,
        command: "/usr/local/bin/opencode",
        host: "127.0.0.1",
        port: 4100,
        workdir: "/workspace/project",
        startupTimeoutMs: options.startupTimeoutMs ?? 30000,
    };
}

class FakeChildProcess extends EventEmitter implements ManagedOpenCodeChildProcess {
    readonly signals: string[] = [];
    killed = false;

    constructor(private readonly exitsOnKill: boolean) {
        super();
    }

    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.signals.push(signal);
        this.killed = true;
        if (this.exitsOnKill) {
            this.emit("exit", null, signal);
        }

        return true;
    }
}
