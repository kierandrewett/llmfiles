import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { type BridgeConfig } from "../src/config.js";
import type { DiscordGatewayBotInfo, DiscordInteraction, DiscordMessage, RegisterDiscordSlashCommandInput } from "../src/discord.js";
import { DiscordGatewayRunner, type DiscordGatewaySocket, discordGatewayIntents } from "../src/discord-gateway.js";
import { createDefaultBridgeState, readBridgeState, writeBridgeState } from "../src/state.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("discordGatewayIntents", () => {
    it("keeps the privileged message content intent opt-in", () => {
        const config = bridgeConfig("/tmp/state.json");

        assert.equal(discordGatewayIntents(config), 4609);
        config.discord.messageContentIntent = true;
        assert.equal(discordGatewayIntents(config), 37377);
    });
});

describe("DiscordGatewayRunner", () => {
    it("identifies after hello, persists READY resume state, and registers slash commands once", async () => {
        const fixture = await createFixture({ registerSlashCommands: true });
        const runner = new DiscordGatewayRunner(fixture.dependencies);

        const run = runner.runOnce();
        const socket = await fixture.waitForSocket();

        socket.emit({ op: 10, d: { heartbeat_interval: 45000 }, s: null, t: null });
        await waitFor(() => socket.sent.length === 1);

        assert.deepEqual(socket.sentJson[0], {
            op: 2,
            d: {
                token: "bot-token",
                intents: 4609,
                properties: {
                    os: process.platform,
                    browser: "opencode-messaging-bridge",
                    device: "opencode-messaging-bridge",
                },
            },
        });

        socket.emit({
            op: 0,
            s: 42,
            t: "READY",
            d: {
                session_id: "gateway-session",
                resume_gateway_url: "wss://resume.discord.test/",
                application: { id: "ready-app-id" },
            },
        });
        await waitFor(() => fixture.discord.registrations.length === 1);
        socket.emitClose();

        assert.equal(await run, 1);
        assert.deepEqual(fixture.discord.registrations, [{ applicationID: "ready-app-id", guildID: "guild-id", name: "oc" }]);
        const state = await readBridgeState(fixture.statePath);
        assert.equal(state.platforms.discord.gatewaySessionID, "gateway-session");
        assert.equal(state.platforms.discord.resumeGatewayUrl, "wss://resume.discord.test/");
        assert.equal(state.platforms.discord.sequence, 42);
        assert.equal(state.deliveries[0]?.type, "discord.slash-command-registration");
    });

    it("uses stored Discord resume state when available", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.platforms.discord.gatewaySessionID = "gateway-session";
        state.platforms.discord.resumeGatewayUrl = "wss://resume.discord.test/";
        state.platforms.discord.sequence = 99;
        await writeBridgeState(fixture.statePath, state);
        const runner = new DiscordGatewayRunner(fixture.dependencies);

        const run = runner.runOnce();
        const socket = await fixture.waitForSocket();

        assert.equal(socket.url, "wss://resume.discord.test/?v=10&encoding=json");
        socket.emit({ op: 10, d: { heartbeat_interval: 45000 }, s: null, t: null });
        await waitFor(() => socket.sent.length === 1);
        socket.emitClose();

        assert.deepEqual(socket.sentJson[0], {
            op: 6,
            d: {
                token: "bot-token",
                session_id: "gateway-session",
                seq: 99,
            },
        });
        assert.equal(await run, 0);
        assert.equal(fixture.discord.gatewayCalls, 0);
    });

    it("routes message and interaction dispatches", async () => {
        const fixture = await createFixture();
        const runner = new DiscordGatewayRunner(fixture.dependencies);

        const run = runner.runOnce();
        const socket = await fixture.waitForSocket();
        socket.emit({
            op: 0,
            s: 1,
            t: "MESSAGE_CREATE",
            d: {
                id: "message-id",
                channel_id: "channel-id",
                guild_id: "guild-id",
                content: "!oc status",
                author: { id: "user-id", bot: false },
            },
        });
        socket.emit({
            op: 0,
            s: 2,
            t: "INTERACTION_CREATE",
            d: {
                id: "interaction-id",
                token: "interaction-token",
                type: 2,
                channel_id: "channel-id",
                guild_id: "guild-id",
                member: { user: { id: "user-id" } },
                data: { name: "oc", type: 1, options: [{ name: "status", type: 1 }] },
            },
        });
        await waitFor(() => fixture.router.messages.length === 1 && fixture.router.interactions.length === 1);
        socket.emitClose();

        assert.equal(await run, 2);
        assert.equal(fixture.router.messages[0]?.content, "!oc status");
        assert.equal(fixture.router.interactions[0]?.id, "interaction-id");
        const state = await readBridgeState(fixture.statePath);
        assert.equal(state.platforms.discord.sequence, 2);
    });
});

interface FixtureOptions {
    registerSlashCommands?: boolean;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    statePath: string;
    dependencies: ConstructorParameters<typeof DiscordGatewayRunner>[0];
    discord: FakeDiscordApi;
    router: FakeGatewayRouter;
    waitForSocket(): Promise<FakeSocket>;
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-discord-gateway-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const discord = new FakeDiscordApi();
    const router = new FakeGatewayRouter();
    const sockets: FakeSocket[] = [];

    return {
        statePath,
        dependencies: {
            config: bridgeConfig(statePath, options),
            discord,
            router,
            createSocket(url: string): DiscordGatewaySocket {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            },
            now: () => new Date("2026-05-09T00:00:00.000Z"),
            random: () => 1,
        },
        discord,
        router,
        async waitForSocket(): Promise<FakeSocket> {
            for (let attempt = 0; attempt < 10; attempt += 1) {
                if (sockets[0]) {
                    return sockets[0];
                }
                await flushAsyncWork();
            }
            throw new Error("socket was not created");
        },
    };
}

class FakeDiscordApi {
    gatewayCalls = 0;
    registrations: RegisterDiscordSlashCommandInput[] = [];

    async getGatewayBot(): Promise<DiscordGatewayBotInfo> {
        this.gatewayCalls += 1;
        return { url: "wss://gateway.discord.test/" };
    }

    async registerSlashCommand(input: RegisterDiscordSlashCommandInput): Promise<void> {
        this.registrations.push(input);
    }
}

class FakeGatewayRouter {
    messages: DiscordMessage[] = [];
    interactions: DiscordInteraction[] = [];

    async handleMessage(message: DiscordMessage): Promise<void> {
        this.messages.push(message);
    }

    async handleInteraction(interaction: DiscordInteraction): Promise<void> {
        this.interactions.push(interaction);
    }
}

class FakeSocket implements DiscordGatewaySocket {
    readonly url: string;
    readyState = 1;
    sent: string[] = [];
    private readonly messageListeners: Array<(event: { data: unknown }) => void> = [];
    private readonly closeListeners: Array<(event: { code: number; reason: string }) => void> = [];
    private readonly errorListeners: Array<(event: { error?: unknown }) => void> = [];

    constructor(url: string) {
        this.url = url;
    }

    get sentJson(): unknown[] {
        return this.sent.map((entry) => JSON.parse(entry) as unknown);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(code = 1000, reason = "test close"): void {
        this.emitClose(code, reason);
    }

    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
    addEventListener(type: "error", listener: (event: { error?: unknown }) => void): void;
    addEventListener(
        type: "message" | "close" | "error",
        listener: ((event: { data: unknown }) => void) | ((event: { code: number; reason: string }) => void) | ((event: { error?: unknown }) => void),
    ): void {
        if (type === "message") {
            this.messageListeners.push(listener as (event: { data: unknown }) => void);
            return;
        }
        if (type === "close") {
            this.closeListeners.push(listener as (event: { code: number; reason: string }) => void);
            return;
        }

        this.errorListeners.push(listener as (event: { error?: unknown }) => void);
    }

    emit(payload: unknown): void {
        for (const listener of this.messageListeners) {
            listener({ data: JSON.stringify(payload) });
        }
    }

    emitClose(code = 1000, reason = "test close"): void {
        this.readyState = 3;
        for (const listener of this.closeListeners) {
            listener({ code, reason });
        }
    }
}

function bridgeConfig(statePath: string, options: FixtureOptions = {}): BridgeConfig {
    return {
        opencode: {
            baseUrl: "http://127.0.0.1:4096",
            process: {
                manage: false,
                command: "opencode",
                host: "127.0.0.1",
                port: 4096,
                workdir: null,
                startupTimeoutMs: 30000,
            },
        },
        statePath,
        implicitReply: false,
        telegram: {
            enabled: false,
            botToken: null,
            allowedUserIDs: [],
            allowedChatIDs: [],
            createTopics: false,
        },
        discord: {
            enabled: true,
            botToken: "bot-token",
            applicationID: null,
            guildID: "guild-id",
            allowedUserIDs: ["user-id"],
            controlChannelID: "control-channel",
            prefix: "!oc",
            slashCommand: "oc",
            registerSlashCommands: options.registerSlashCommands ?? false,
            slashResponsesEphemeral: true,
            messageContentIntent: false,
            maxMessageChars: 1850,
        },
    };
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) {
            return;
        }
        await flushAsyncWork();
    }

    throw new Error("condition was not met");
}
