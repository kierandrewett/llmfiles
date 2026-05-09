import { pathToFileURL } from "node:url";

import { type Env, loadBridgeConfig } from "./config.js";
import { DiscordEventRelay } from "./discord-event-relay.js";
import { DiscordGatewayRunner } from "./discord-gateway.js";
import { DiscordBridgeRouter } from "./discord-router.js";
import { DiscordBotApiClient } from "./discord.js";
import { OpenCodeEventPump } from "./opencode-event-pump.js";
import { OpenCodeProcessManager } from "./opencode-process.js";
import { OpenCodeHttpClient, type OpenCodeHealth, type OpenCodeSession } from "./opencode.js";
import { loadOrCreateBridgeState } from "./state.js";
import { TelegramEventRelay } from "./telegram-event-relay.js";
import { TelegramBridgePoller } from "./telegram-poller.js";
import { TelegramBridgeRouter } from "./telegram-router.js";
import { TelegramBotApiClient } from "./telegram.js";

const TELEGRAM_DISABLED_MESSAGE = "Telegram bridge is not enabled. "
    + "Set OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN and OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS.";
const DISCORD_DISABLED_MESSAGE = "Discord bridge is not enabled. "
    + "Set OPENCODE_BRIDGE_DISCORD_BOT_TOKEN, OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID, and OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS.";

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
    telegramPoller?: TelegramPollerLike;
    discordGateway?: DiscordGatewayLike;
    eventPump?: OpenCodeEventPumpLike;
    processManager?: OpenCodeProcessManagerLike;
}

export interface TelegramPollerLike {
    runOnce(): Promise<number>;
}

export interface DiscordGatewayLike {
    runOnce(): Promise<number>;
}

export interface OpenCodeEventPumpLike {
    runOnce(): Promise<number>;
}

export interface OpenCodeProcessManagerLike {
    start(): Promise<string>;
    stop(): Promise<void>;
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

        if (command === "telegram-once") {
            const poller = telegramPoller(config, dependencies);
            return await withOpenCodeProcess(config, dependencies, async () => {
                const processed = await poller.runOnce();
                stdout(`[bridge] telegram processed ${processed} update(s)`);
                return 0;
            });
        }

        if (command === "telegram") {
            const poller = telegramPoller(config, dependencies);
            const pump = openCodeEventPump(config, dependencies, "telegram");
            return await withOpenCodeProcess(config, dependencies, async () => {
                await Promise.all([
                    runTelegramLoop(poller, stdout, stderr),
                    runOpenCodeEventLoop(pump, stdout, stderr),
                ]);
                return 0;
            });
        }

        if (command === "discord-once") {
            const gateway = discordGateway(config, dependencies);
            return await withOpenCodeProcess(config, dependencies, async () => {
                const processed = await gateway.runOnce();
                stdout(`[bridge] discord processed ${processed} gateway dispatch event(s)`);
                return 0;
            });
        }

        if (command === "discord") {
            const gateway = discordGateway(config, dependencies);
            const pump = openCodeEventPump(config, dependencies, "discord");
            return await withOpenCodeProcess(config, dependencies, async () => {
                await Promise.all([
                    runDiscordGatewayLoop(gateway, stdout, stderr),
                    runOpenCodeEventLoop(pump, stdout, stderr),
                ]);
                return 0;
            });
        }

        if (command === "status") {
            return await withOpenCodeProcess(config, dependencies, async () => {
                const health = await client.health();
                stdout(`[bridge] OpenCode healthy: ${String(health.healthy)}`);
                stdout(`[bridge] OpenCode version: ${health.version}`);
                stdout(`[bridge] state: ${config.statePath}`);
                return 0;
            });
        }

        if (command === "sessions") {
            return await withOpenCodeProcess(config, dependencies, async () => {
                const sessions = await client.listSessions({ limit: 20 });
                if (sessions.length === 0) {
                    stdout("[bridge] no sessions found");
                    return 0;
                }

                for (const session of sessions) {
                    stdout(formatSessionLine(session));
                }
                return 0;
            });
        }

        if (command === "new") {
            return await withOpenCodeProcess(config, dependencies, async () => {
                const title = argv.slice(1).join(" ").trim();
                const session = await client.createSession(title ? { title } : {});
                stdout(`[bridge] created session ${formatSessionLine(session)}`);
                return 0;
            });
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

async function withOpenCodeProcess(
    config: ReturnType<typeof loadBridgeConfig>,
    dependencies: CliDependencies,
    action: () => Promise<number>,
): Promise<number> {
    const manager = opencodeProcessManager(config, dependencies);
    await manager.start();
    try {
        return await action();
    } finally {
        await manager.stop();
    }
}

function opencodeProcessManager(
    config: ReturnType<typeof loadBridgeConfig>,
    dependencies: CliDependencies,
): OpenCodeProcessManagerLike {
    if (dependencies.processManager) {
        return dependencies.processManager;
    }

    return new OpenCodeProcessManager({
        baseUrl: config.opencode.baseUrl,
        process: config.opencode.process,
    });
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
    output("  telegram-once       Poll Telegram once and process returned updates");
    output("  telegram            Run Telegram long polling continuously");
    output("  discord-once        Connect to Discord Gateway once and process dispatches until close");
    output("  discord             Run Discord Gateway continuously");
}

function telegramPoller(
    config: ReturnType<typeof loadBridgeConfig>,
    dependencies: CliDependencies,
): TelegramPollerLike {
    const botToken = telegramBotToken(config);
    if (dependencies.telegramPoller) {
        return dependencies.telegramPoller;
    }

    const opencode = new OpenCodeHttpClient({ baseUrl: config.opencode.baseUrl });
    const telegram = new TelegramBotApiClient({ botToken });
    const router = new TelegramBridgeRouter({ config, opencode, telegram });

    return new TelegramBridgePoller({ statePath: config.statePath, telegram, router });
}

function openCodeEventPump(
    config: ReturnType<typeof loadBridgeConfig>,
    dependencies: CliDependencies,
    platform: "telegram" | "discord",
): OpenCodeEventPumpLike {
    if (dependencies.eventPump) {
        return dependencies.eventPump;
    }

    const source = new OpenCodeHttpClient({ baseUrl: config.opencode.baseUrl });
    if (platform === "telegram") {
        const telegram = new TelegramBotApiClient({ botToken: telegramBotToken(config) });
        const handler = new TelegramEventRelay({ statePath: config.statePath, telegram });

        return new OpenCodeEventPump({ source, handler });
    }

    const discord = new DiscordBotApiClient({
        botToken: discordBotToken(config),
        maxMessageChars: config.discord.maxMessageChars,
    });
    const handler = new DiscordEventRelay({ statePath: config.statePath, discord });

    return new OpenCodeEventPump({ source, handler });
}

function telegramBotToken(config: ReturnType<typeof loadBridgeConfig>): string {
    if (!config.telegram.enabled || !config.telegram.botToken) {
        throw new Error(TELEGRAM_DISABLED_MESSAGE);
    }

    return config.telegram.botToken;
}

function discordGateway(
    config: ReturnType<typeof loadBridgeConfig>,
    dependencies: CliDependencies,
): DiscordGatewayLike {
    const botToken = discordBotToken(config);
    if (dependencies.discordGateway) {
        return dependencies.discordGateway;
    }

    const opencode = new OpenCodeHttpClient({ baseUrl: config.opencode.baseUrl });
    const discord = new DiscordBotApiClient({ botToken, maxMessageChars: config.discord.maxMessageChars });
    const router = new DiscordBridgeRouter({ config, opencode, discord });

    return new DiscordGatewayRunner({ config, discord, router });
}

function discordBotToken(config: ReturnType<typeof loadBridgeConfig>): string {
    if (!config.discord.enabled || !config.discord.botToken) {
        throw new Error(DISCORD_DISABLED_MESSAGE);
    }

    return config.discord.botToken;
}

async function runTelegramLoop(
    poller: TelegramPollerLike,
    stdout: (line: string) => void,
    stderr: (line: string) => void,
): Promise<never> {
    stdout("[bridge] telegram polling started");

    for (;;) {
        try {
            const processed = await poller.runOnce();
            if (processed > 0) {
                stdout(`[bridge] telegram processed ${processed} update(s)`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stderr(`[bridge] telegram polling failed: ${message}`);
            await delay(5000);
        }
    }
}

async function runDiscordGatewayLoop(
    gateway: DiscordGatewayLike,
    stdout: (line: string) => void,
    stderr: (line: string) => void,
): Promise<never> {
    stdout("[bridge] discord gateway started");

    for (;;) {
        try {
            const processed = await gateway.runOnce();
            stdout(`[bridge] discord gateway disconnected after ${processed} dispatch event(s); reconnecting`);
            await delay(1000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stderr(`[bridge] discord gateway failed: ${message}`);
            await delay(5000);
        }
    }
}

async function runOpenCodeEventLoop(
    pump: OpenCodeEventPumpLike,
    stdout: (line: string) => void,
    stderr: (line: string) => void,
): Promise<never> {
    stdout("[bridge] opencode event relay started");

    for (;;) {
        try {
            const processed = await pump.runOnce();
            stdout(`[bridge] opencode event stream ended after ${processed} event(s); reconnecting`);
            await delay(1000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stderr(`[bridge] opencode event relay failed: ${message}`);
            await delay(5000);
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const exitCode = await runCli();
    process.exitCode = exitCode;
}
