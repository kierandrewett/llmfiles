import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleepMs } from "node:timers/promises";

import type { OpenCodeProcessConfig } from "./config.js";
import { OpenCodeHttpClient, type OpenCodeHealth } from "./opencode.js";

const HEALTH_POLL_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 5000;

export interface ManagedOpenCodeChildProcess {
    readonly killed?: boolean;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface SpawnOpenCodeOptions {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: "ignore";
}

export type SpawnOpenCodeProcess = (
    command: string,
    args: string[],
    options: SpawnOpenCodeOptions,
) => ManagedOpenCodeChildProcess;

export interface OpenCodeHealthClient {
    health(): Promise<OpenCodeHealth>;
}

export interface OpenCodeProcessManagerDependencies {
    baseUrl: string;
    process: OpenCodeProcessConfig;
    healthClient?: OpenCodeHealthClient;
    spawn?: SpawnOpenCodeProcess;
    nowMs?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

interface ChildExitState {
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
}

export class OpenCodeProcessManager {
    private readonly baseUrl: string;
    private readonly processConfig: OpenCodeProcessConfig;
    private readonly healthClient: OpenCodeHealthClient;
    private readonly spawnProcess: SpawnOpenCodeProcess;
    private readonly nowMs: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private child: ManagedOpenCodeChildProcess | null = null;
    private childExit: Promise<ChildExitState> | null = null;
    private childExitState: ChildExitState | null = null;

    constructor(dependencies: OpenCodeProcessManagerDependencies) {
        this.baseUrl = dependencies.baseUrl;
        this.processConfig = dependencies.process;
        this.healthClient = dependencies.healthClient ?? new OpenCodeHttpClient({ baseUrl: dependencies.baseUrl });
        this.spawnProcess = dependencies.spawn ?? defaultSpawnOpenCodeProcess;
        this.nowMs = dependencies.nowMs ?? Date.now;
        this.sleep = dependencies.sleep ?? sleepMs;
    }

    async start(): Promise<string> {
        if (!this.processConfig.manage) {
            return this.baseUrl;
        }
        if (this.child) {
            return this.baseUrl;
        }

        this.child = this.spawnProcess(this.processConfig.command, this.args(), this.spawnOptions());
        this.childExit = this.watchChildExit(this.child);

        try {
            await this.waitUntilHealthy();
        } catch (error) {
            await this.stop();
            throw error;
        }

        return this.baseUrl;
    }

    async stop(): Promise<void> {
        const child = this.child;
        const childExit = this.childExit;
        if (!child) {
            return;
        }

        this.child = null;
        this.childExit = null;

        if (!this.childExitState && !child.killed) {
            child.kill("SIGTERM");
        }

        if (!childExit) {
            return;
        }

        const stopped = await Promise.race([
            childExit.then(() => true),
            this.sleep(STOP_TIMEOUT_MS).then(() => false),
        ]);

        if (!stopped) {
            child.kill("SIGKILL");
        }
    }

    private args(): string[] {
        return [
            "serve",
            "--hostname",
            this.processConfig.host,
            "--port",
            String(this.processConfig.port),
        ];
    }

    private spawnOptions(): SpawnOpenCodeOptions {
        return {
            ...(this.processConfig.workdir ? { cwd: this.processConfig.workdir } : {}),
            env: process.env,
            stdio: "ignore",
        };
    }

    private watchChildExit(child: ManagedOpenCodeChildProcess): Promise<ChildExitState> {
        return new Promise((resolve) => {
            child.once("error", (error) => {
                const state = { code: null, signal: null, error };
                this.childExitState = state;
                resolve(state);
            });
            child.once("exit", (code, signal) => {
                const state = { code, signal, error: null };
                this.childExitState = state;
                resolve(state);
            });
        });
    }

    private async waitUntilHealthy(): Promise<void> {
        const deadline = this.nowMs() + this.processConfig.startupTimeoutMs;
        let lastError: Error | null = null;

        while (this.nowMs() <= deadline) {
            this.throwIfChildExitedBeforeHealth();

            try {
                const health = await this.healthClient.health();
                if (health.healthy) {
                    return;
                }

                lastError = new Error("OpenCode health check returned unhealthy");
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }

            const remainingMs = deadline - this.nowMs();
            if (remainingMs <= 0) {
                break;
            }

            await this.sleep(Math.min(HEALTH_POLL_INTERVAL_MS, remainingMs));
        }

        const reason = lastError ? `: ${lastError.message}` : "";
        throw new Error(`OpenCode did not become healthy within ${String(this.processConfig.startupTimeoutMs)}ms${reason}`);
    }

    private throwIfChildExitedBeforeHealth(): void {
        if (!this.childExitState) {
            return;
        }
        if (this.childExitState.error) {
            throw new Error(`OpenCode process failed to start: ${this.childExitState.error.message}`);
        }

        throw new Error(
            `OpenCode process exited before health check passed `
                + `(code=${String(this.childExitState.code)}, signal=${String(this.childExitState.signal)})`,
        );
    }
}

const defaultSpawnOpenCodeProcess: SpawnOpenCodeProcess = (command, args, options) => {
    return nodeSpawn(command, args, options) as ManagedOpenCodeChildProcess;
};
