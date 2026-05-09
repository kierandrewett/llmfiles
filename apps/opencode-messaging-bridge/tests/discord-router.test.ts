import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { type BridgeConfig } from "../src/config.js";
import type { DiscordInteraction, DiscordMessage, PongDiscordInteractionInput, SendDiscordInteractionMessageInput, SendDiscordMessageInput } from "../src/discord.js";
import { DiscordBridgeRouter, parseDiscordMessageCommand, parseDiscordSlashCommand } from "../src/discord-router.js";
import { type OpenCodeHealth, type OpenCodePermissionResponse, type OpenCodeSession } from "../src/opencode.js";
import { createDefaultBridgeState, readBridgeState, writeBridgeState } from "../src/state.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Discord command parsing", () => {
    it("parses prefix commands and implicit replies", () => {
        assert.deepEqual(parseDiscordMessageCommand("!oc prompt hello there", "!oc", false), {
            name: "prompt",
            args: ["hello", "there"],
            text: "hello there",
        });
        assert.deepEqual(parseDiscordMessageCommand("plain reply", "!oc", true), {
            name: "reply",
            args: ["plain reply"],
            text: "plain reply",
        });
        assert.equal(parseDiscordMessageCommand("plain reply", "!oc", false), null);
    });

    it("parses slash subcommands", () => {
        const parsed = parseDiscordSlashCommand(interaction("user-id", "control-channel", "prompt", "text", "hello"), "oc");

        assert.deepEqual(parsed, { name: "prompt", args: ["hello"], text: "hello" });
    });

    it("parses slash permission decisions", () => {
        const parsed = parseDiscordSlashCommand(interaction("user-id", "control-channel", "deny", "permission_id", "per_123", "message", "too risky"), "oc");

        assert.deepEqual(parsed, { name: "deny", args: ["per_123", "too risky"], text: "per_123 too risky" });
    });

    it("parses schedule slash commands", () => {
        const parsed = parseDiscordSlashCommand(interaction("user-id", "control-channel", "schedule", "text", "every 15m check status"), "oc");

        assert.deepEqual(parsed, { name: "schedule", args: ["every", "15m", "check", "status"], text: "every 15m check status" });
    });
});

describe("DiscordBridgeRouter", () => {
    it("ignores messages from users outside the allowlist", async () => {
        const fixture = await createFixture();
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("other-user", "control-channel", "!oc status"));

        assert.deepEqual(fixture.discord.messages, []);
        assert.equal(fixture.opencode.healthCalls, 0);
    });

    it("responds to status commands in the control channel", async () => {
        const fixture = await createFixture();
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("user-id", "control-channel", "!oc status"));

        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), [
            "[bridge] OpenCode healthy: true\n[bridge] OpenCode version: 1.3.17\n[bridge] active session: none",
        ]);
    });

    it("attaches the latest session and persists the Discord binding", async () => {
        const fixture = await createFixture({ sessions: [{ id: "ses_abc", title: "Example", directory: "/tmp/project", time: null }] });
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("user-id", "control-channel", "!oc attach latest"));

        const state = await readBridgeState(fixture.statePath);
        assert.equal(state.surfaces[0]?.id, "discord:control-channel");
        assert.equal(state.surfaces[0]?.activeSessionID, "ses_abc");
        assert.equal(state.bindings[0]?.platform, "discord");
        assert.equal(state.bindings[0]?.sessionID, "ses_abc");
        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), ["[bridge] attached ses_abc\tExample"]);
    });

    it("sends prompts to the active session", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "discord:control-channel", platform: "discord", surface: { channelID: "control-channel", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        state.bindings.push({
            id: "discord:control-channel:ses_abc",
            platform: "discord",
            surface: { channelID: "control-channel", threadID: null },
            sessionID: "ses_abc",
            directory: null,
            title: "Example",
            createdAt: state.updatedAt,
            updatedAt: state.updatedAt,
        });
        await writeBridgeState(fixture.statePath, state);
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("user-id", "control-channel", "!oc prompt hello there"));

        assert.deepEqual(fixture.discord.typing, ["control-channel"]);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_abc", text: "hello there" }]);
        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), ["[bridge] prompt sent to ses_abc"]);
    });

    it("schedules prompts against the active Discord session", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "discord:control-channel", platform: "discord", surface: { channelID: "control-channel", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        await writeBridgeState(fixture.statePath, state);
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("user-id", "control-channel", "!oc schedule every 15m check status"));
        await router.handleMessage(message("user-id", "control-channel", "!oc jobs"));

        const read = await readBridgeState(fixture.statePath);
        assert.equal(read.jobs.length, 1);
        assert.equal(read.jobs[0]?.id, "job_20260509T000000000Z_1");
        assert.equal(read.jobs[0]?.sessionID, "ses_abc");
        assert.equal(read.jobs[0]?.prompt, "check status");
        assert.equal(read.jobs[0]?.nextRunAt, "2026-05-09T00:15:00.000Z");
        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), [
            "[bridge] scheduled job_20260509T000000000Z_1 every 15m for ses_abc",
            "[bridge] job_20260509T000000000Z_1 every 15m next 2026-05-09T00:15:00.000Z session ses_abc",
        ]);
    });

    it("runs and unschedules Discord scheduled prompts by job ID", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "discord:control-channel", platform: "discord", surface: { channelID: "control-channel", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        state.jobs.push({
            id: "job_1",
            platform: "discord",
            surfaceID: "discord:control-channel",
            surface: { channelID: "control-channel", threadID: null },
            sessionID: "ses_abc",
            prompt: "check status",
            intervalMinutes: 15,
            nextRunAt: "2026-05-09T00:15:00.000Z",
            lastRunAt: null,
            lastError: null,
            createdAt: state.updatedAt,
            updatedAt: state.updatedAt,
        });
        await writeBridgeState(fixture.statePath, state);
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("user-id", "control-channel", "!oc run-now job_1"));
        await router.handleMessage(message("user-id", "control-channel", "!oc unschedule job_1"));

        const read = await readBridgeState(fixture.statePath);
        assert.deepEqual(fixture.opencode.prompts, [{ sessionID: "ses_abc", text: "check status" }]);
        assert.deepEqual(read.jobs, []);
        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), [
            "[bridge] ran scheduled job job_1 for ses_abc",
            "[bridge] unscheduled job_1",
        ]);
    });

    it("routes permission decisions to OpenCode", async () => {
        const fixture = await createFixture();
        const state = createDefaultBridgeState(new Date("2026-05-09T00:00:00.000Z"));
        state.surfaces.push({ id: "discord:control-channel", platform: "discord", surface: { channelID: "control-channel", threadID: null }, activeSessionID: "ses_abc", updatedAt: state.updatedAt });
        await writeBridgeState(fixture.statePath, state);
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("user-id", "control-channel", "!oc allow per_once"));
        await router.handleMessage(message("user-id", "control-channel", "!oc always per_always"));
        await router.handleMessage(message("user-id", "control-channel", "!oc deny per_reject too risky"));

        assert.deepEqual(fixture.opencode.permissionReplies, [
            { sessionID: "ses_abc", permissionID: "per_once", response: "once" },
            { sessionID: "ses_abc", permissionID: "per_always", response: "always" },
            { sessionID: "ses_abc", permissionID: "per_reject", response: "reject", message: "too risky" },
        ]);
        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), [
            "[bridge] permission once sent for per_once",
            "[bridge] permission always sent for per_always",
            "[bridge] permission reject sent for per_reject",
        ]);
    });

    it("rejects permission commands without a permission ID", async () => {
        const fixture = await createFixture();
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleMessage(message("user-id", "control-channel", "!oc allow"));

        assert.deepEqual(fixture.opencode.permissionReplies, []);
        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), ["[bridge] permission ID is required"]);
    });

    it("acks allowed slash interactions before posting output to the channel", async () => {
        const fixture = await createFixture({ sessions: [{ id: "ses_abc", title: "Example", directory: null, time: null }] });
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleInteraction(interaction("user-id", "control-channel", "attach", "session_id", "latest"));

        assert.deepEqual(fixture.discord.interactions.map((entry) => entry.content), ["Accepted /oc attach. Output will be posted in this channel."]);
        assert.deepEqual(fixture.discord.messages.map((entry) => entry.content), ["[bridge] attached ses_abc\tExample"]);
    });

    it("rejects slash interactions from users outside the allowlist", async () => {
        const fixture = await createFixture();
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleInteraction(interaction("other-user", "control-channel", "status"));

        assert.deepEqual(fixture.discord.interactions.map((entry) => entry.content), ["This Discord user is not allowed to control OpenCode."]);
        assert.deepEqual(fixture.discord.messages, []);
    });

    it("responds to Discord interaction pings", async () => {
        const fixture = await createFixture();
        const router = new DiscordBridgeRouter(fixture.dependencies);

        await router.handleInteraction({ id: "ping-id", token: "ping-token", type: 1, channelID: null, guildID: null, userID: null, data: null });

        assert.deepEqual(fixture.discord.pongs, [{ interactionID: "ping-id", interactionToken: "ping-token" }]);
    });
});

interface FixtureOptions {
    sessions?: OpenCodeSession[];
    createdSession?: OpenCodeSession;
}

interface FakeOpenCode {
    healthCalls: number;
    createdTitles: string[];
    prompts: Array<{ sessionID: string; text: string }>;
    permissionReplies: Array<{ sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string }>;
    health(): Promise<OpenCodeHealth>;
    listSessions(options?: { limit?: number }): Promise<OpenCodeSession[]>;
    getSession(input: { sessionID: string }): Promise<OpenCodeSession>;
    createSession(input?: { title?: string }): Promise<OpenCodeSession>;
    sendPrompt(input: { sessionID: string; text: string }): Promise<void>;
    abortSession(input: { sessionID: string }): Promise<void>;
    replyPermission(input: { sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string }): Promise<void>;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
    statePath: string;
    dependencies: ConstructorParameters<typeof DiscordBridgeRouter>[0];
    discord: {
        messages: SendDiscordMessageInput[];
        interactions: SendDiscordInteractionMessageInput[];
        pongs: PongDiscordInteractionInput[];
        typing: string[];
    };
    opencode: FakeOpenCode;
}> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-discord-router-test-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "state.json");
    const discord = {
        messages: [] as SendDiscordMessageInput[],
        interactions: [] as SendDiscordInteractionMessageInput[],
        pongs: [] as PongDiscordInteractionInput[],
        typing: [] as string[],
        async sendMessage(input: SendDiscordMessageInput): Promise<void> {
            discord.messages.push(input);
        },
        async sendTyping(input: { channelID: string }): Promise<void> {
            discord.typing.push(input.channelID);
        },
        async sendInteractionMessage(input: SendDiscordInteractionMessageInput): Promise<void> {
            discord.interactions.push(input);
        },
        async pongInteraction(input: PongDiscordInteractionInput): Promise<void> {
            discord.pongs.push(input);
        },
    };
    const opencode: FakeOpenCode = {
        healthCalls: 0,
        createdTitles: [],
        prompts: [],
        permissionReplies: [],
        async health(): Promise<OpenCodeHealth> {
            opencode.healthCalls += 1;
            return { healthy: true, version: "1.3.17" };
        },
        async listSessions(): Promise<OpenCodeSession[]> {
            return options.sessions ?? [];
        },
        async getSession(input: { sessionID: string }): Promise<OpenCodeSession> {
            return options.sessions?.find((session) => session.id === input.sessionID) ?? { id: input.sessionID, title: null, directory: null, time: null };
        },
        async createSession(input: { title?: string } = {}): Promise<OpenCodeSession> {
            opencode.createdTitles.push(input.title ?? "");
            return options.createdSession ?? { id: "ses_new", title: input.title ?? null, directory: null, time: null };
        },
        async sendPrompt(input: { sessionID: string; text: string }): Promise<void> {
            opencode.prompts.push(input);
        },
        async abortSession(): Promise<void> {
            return undefined;
        },
        async replyPermission(input: { sessionID?: string; permissionID: string; response: OpenCodePermissionResponse; message?: string }): Promise<void> {
            opencode.permissionReplies.push(input);
        },
    };

    return {
        statePath,
        dependencies: {
            config: bridgeConfig(statePath),
            discord,
            opencode,
            now: () => new Date("2026-05-09T00:00:00.000Z"),
        },
        discord,
        opencode,
    };
}

function bridgeConfig(statePath: string): BridgeConfig {
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
            applicationID: "app-id",
            guildID: "guild-id",
            allowedUserIDs: ["user-id"],
            controlChannelID: "control-channel",
            prefix: "!oc",
            slashCommand: "oc",
            registerSlashCommands: false,
            slashResponsesEphemeral: true,
            messageContentIntent: false,
            maxMessageChars: 1850,
        },
    };
}

function message(userID: string, channelID: string, content: string): DiscordMessage {
    return {
        id: "message-id",
        channelID,
        guildID: "guild-id",
        userID,
        authorBot: false,
        content,
    };
}

function interaction(
    userID: string,
    channelID: string,
    subcommand: string,
    optionName?: string,
    optionValue?: string,
    secondOptionName?: string,
    secondOptionValue?: string,
): DiscordInteraction {
    const options = optionName ? [{ name: optionName, type: 3, value: optionValue ?? "" }] : [];
    if (secondOptionName) {
        options.push({ name: secondOptionName, type: 3, value: secondOptionValue ?? "" });
    }

    return {
        id: "interaction-id",
        token: "interaction-token",
        type: 2,
        channelID,
        guildID: "guild-id",
        userID,
        data: {
            name: "oc",
            type: 1,
            options: [
                {
                    name: subcommand,
                    type: 1,
                    options,
                },
            ],
        },
    };
}
