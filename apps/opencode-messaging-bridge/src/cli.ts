import { pathToFileURL } from "node:url";

import { type Env, loadBridgeConfig } from "./config.js";
import { OpenCodeHttpClient, type OpenCodeHealth, type OpenCodeSession } from "./opencode.js";
import { loadOrCreateBridgeState } from "./state.js";

export interface OpenCodeClientLike {
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number; directory?: string }): Promise<OpenCodeSession[]>;
    createSession(input?: { title?: string; directory?: string }): Promise<OpenCodeSession>;
}

export interface CliDependencies {
    env?: Env;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    client?: OpenCodeClientLike;
}

export async function runCli(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
    const command = argv[0] ?? "help";
    const stdout = dependencies.stdout ?? console.log;
    const stderr = dependencies.stderr ?? console.error;

    if (command === "help" || command === "--help" || command === "-h") {
        printHelp(stdout);
        return 0;
    }

    try {
        const env = dependencies.env ?? process.env;
        const config = loadBridgeConfig(env);
        await loadOrCreateBridgeState(config.statePath);
        const client = dependencies.client ?? new OpenCodeHttpClient({ baseUrl: config.opencode.baseUrl });

        if (command === "status") {
            const health = await client.health();
            stdout(`[bridge] OpenCode healthy: ${String(health.healthy)}`);
            stdout(`[bridge] OpenCode version: ${health.version}`);
            stdout(`[bridge] state: ${config.statePath}`);
            return 0;
        }

        if (command === "sessions") {
            const sessions = await client.listSessions({ limit: 20 });
            if (sessions.length === 0) {
                stdout("[bridge] no sessions found");
                return 0;
            }

            for (const session of sessions) {
                stdout(formatSessionLine(session));
            }
            return 0;
        }

        if (command === "new") {
            const title = argv.slice(1).join(" ").trim();
            const session = await client.createSession(title ? { title } : {});
            stdout(`[bridge] created session ${formatSessionLine(session)}`);
            return 0;
        }

        stderr(`[bridge] unknown command: ${command}`);
        printHelp(stderr);
        return 1;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(`[bridge] ${message}`);
        return 1;
    }
}

function formatSessionLine(session: OpenCodeSession): string {
    return `${session.id}\t${session.title ?? "(untitled)"}`;
}

function printHelp(output: (line: string) => void): void {
    output("OpenCode messaging bridge");
    output("");
    output("Commands:");
    output("  status              Check OpenCode health and state path");
    output("  sessions            List recent OpenCode sessions");
    output("  new [title]         Create an OpenCode session");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const exitCode = await runCli();
    process.exitCode = exitCode;
}
