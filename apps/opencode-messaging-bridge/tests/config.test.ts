import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultStatePath, loadBridgeConfig, parseIDList } from "../src/config.js";

describe("parseIDList", () => {
    it("trims comma-separated values and drops empty entries", () => {
        assert.deepEqual(parseIDList(" 123,456, ,789 "), ["123", "456", "789"]);
    });

    it("returns an empty list for unset values", () => {
        assert.deepEqual(parseIDList(undefined), []);
    });
});

describe("defaultStatePath", () => {
    it("uses XDG_STATE_HOME when it is set", () => {
        assert.equal(defaultStatePath({ HOME: "/home/example", XDG_STATE_HOME: "/tmp/state" }), "/tmp/state/opencode-messaging-bridge/state.json");
    });

    it("falls back to HOME/.local/state", () => {
        assert.equal(defaultStatePath({ HOME: "/home/example" }), "/home/example/.local/state/opencode-messaging-bridge/state.json");
    });
});

describe("loadBridgeConfig", () => {
    it("loads safe defaults without requiring platform tokens", () => {
        const config = loadBridgeConfig({ HOME: "/home/example" });

        assert.equal(config.opencode.baseUrl, "http://127.0.0.1:4096");
        assert.deepEqual(config.opencode.process, {
            manage: false,
            command: "opencode",
            host: "127.0.0.1",
            port: 4096,
            workdir: null,
            startupTimeoutMs: 30000,
        });
        assert.equal(config.statePath, "/home/example/.local/state/opencode-messaging-bridge/state.json");
        assert.equal(config.implicitReply, false);
        assert.equal(config.telegram.enabled, false);
        assert.equal(config.discord.enabled, false);
        assert.deepEqual(config.workspace, {
            root: null,
        });
        assert.deepEqual(config.intentResolver, {
            enabled: false,
            maxClarificationTurns: 4,
            clarificationTtlMs: 600000,
        });
        assert.deepEqual(config.voice, {
            enabled: false,
            maxAudioBytes: 20971520,
            openrouter: {
                apiKey: null,
                baseUrl: "https://openrouter.ai/api/v1",
                model: "openai/whisper-1",
                language: null,
            },
        });
    });

    it("loads managed OpenCode process settings and derives the default base URL", () => {
        const config = loadBridgeConfig({
            HOME: "/home/example",
            OPENCODE_BRIDGE_MANAGE_OPENCODE: "true",
            OPENCODE_BRIDGE_OPENCODE_COMMAND: "/usr/local/bin/opencode",
            OPENCODE_BRIDGE_OPENCODE_HOST: "0.0.0.0",
            OPENCODE_BRIDGE_OPENCODE_PORT: "4100",
            OPENCODE_BRIDGE_OPENCODE_WORKDIR: "/workspace/project",
            OPENCODE_BRIDGE_OPENCODE_STARTUP_TIMEOUT_MS: "15000",
        });

        assert.equal(config.opencode.baseUrl, "http://127.0.0.1:4100");
        assert.deepEqual(config.opencode.process, {
            manage: true,
            command: "/usr/local/bin/opencode",
            host: "0.0.0.0",
            port: 4100,
            workdir: "/workspace/project",
            startupTimeoutMs: 15000,
        });
    });

    it("lets an explicit OpenCode base URL override the managed bind address", () => {
        const config = loadBridgeConfig({
            HOME: "/home/example",
            OPENCODE_BRIDGE_MANAGE_OPENCODE: "1",
            OPENCODE_BRIDGE_OPENCODE_HOST: "0.0.0.0",
            OPENCODE_BRIDGE_OPENCODE_PORT: "4100",
            OPENCODE_BRIDGE_OPENCODE_BASE_URL: "http://opencode.internal:4100/",
        });

        assert.equal(config.opencode.baseUrl, "http://opencode.internal:4100");
    });

    it("normalises explicit URLs and parses allowlists", () => {
        const config = loadBridgeConfig({
            HOME: "/home/example",
            OPENCODE_BRIDGE_OPENCODE_BASE_URL: "http://localhost:4096/",
            OPENCODE_BRIDGE_IMPLICIT_REPLY: "1",
            OPENCODE_BRIDGE_TELEGRAM_BOT_TOKEN: "telegram-token",
            OPENCODE_BRIDGE_TELEGRAM_ALLOWED_USER_IDS: "123, 456",
            OPENCODE_BRIDGE_TELEGRAM_ALLOWED_CHAT_IDS: "999",
            OPENCODE_BRIDGE_TELEGRAM_CREATE_TOPICS: "1",
            OPENCODE_BRIDGE_DISCORD_BOT_TOKEN: "discord-token",
            OPENCODE_BRIDGE_DISCORD_APPLICATION_ID: "app-id",
            OPENCODE_BRIDGE_DISCORD_GUILD_ID: "guild-id",
            OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS: "abc, def",
            OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID: "channel-id",
            OPENCODE_BRIDGE_DISCORD_PREFIX: "!dev",
            OPENCODE_BRIDGE_DISCORD_SLASH_COMMAND: "OC_DEV",
            OPENCODE_BRIDGE_DISCORD_REGISTER_SLASH_COMMANDS: "1",
            OPENCODE_BRIDGE_DISCORD_SLASH_EPHEMERAL: "0",
            OPENCODE_BRIDGE_DISCORD_MESSAGE_CONTENT_INTENT: "yes",
            OPENCODE_BRIDGE_DISCORD_MAX_MESSAGE_CHARS: "1200",
        });

        assert.equal(config.opencode.baseUrl, "http://localhost:4096");
        assert.equal(config.implicitReply, true);
        assert.deepEqual(config.telegram.allowedUserIDs, ["123", "456"]);
        assert.deepEqual(config.telegram.allowedChatIDs, ["999"]);
        assert.equal(config.telegram.createTopics, true);
        assert.equal(config.telegram.enabled, true);
        assert.deepEqual(config.discord.allowedUserIDs, ["abc", "def"]);
        assert.equal(config.discord.applicationID, "app-id");
        assert.equal(config.discord.guildID, "guild-id");
        assert.equal(config.discord.controlChannelID, "channel-id");
        assert.equal(config.discord.prefix, "!dev");
        assert.equal(config.discord.slashCommand, "oc_dev");
        assert.equal(config.discord.registerSlashCommands, true);
        assert.equal(config.discord.slashResponsesEphemeral, false);
        assert.equal(config.discord.messageContentIntent, true);
        assert.equal(config.discord.maxMessageChars, 1200);
        assert.equal(config.discord.enabled, true);
    });

    it("loads safe Discord daemon defaults", () => {
        const config = loadBridgeConfig({ HOME: "/home/example" });

        assert.equal(config.discord.prefix, "!oc");
        assert.equal(config.discord.slashCommand, "oc");
        assert.equal(config.discord.registerSlashCommands, false);
        assert.equal(config.discord.slashResponsesEphemeral, true);
        assert.equal(config.discord.messageContentIntent, false);
        assert.equal(config.discord.maxMessageChars, 1850);
    });

    it("loads opt-in OpenRouter voice transcription settings", () => {
        const config = loadBridgeConfig({
            HOME: "/home/example",
            OPENCODE_BRIDGE_VOICE_TRANSCRIPTION: "1",
            OPENCODE_BRIDGE_OPENROUTER_API_KEY: "openrouter-key",
            OPENCODE_BRIDGE_OPENROUTER_BASE_URL: "https://openrouter.test/api/v1/",
            OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_MODEL: "openai/whisper-large-v3",
            OPENCODE_BRIDGE_OPENROUTER_TRANSCRIPTION_LANGUAGE: "en",
            OPENCODE_BRIDGE_VOICE_MAX_AUDIO_BYTES: "1048576",
        });

        assert.deepEqual(config.voice, {
            enabled: true,
            maxAudioBytes: 1048576,
            openrouter: {
                apiKey: "openrouter-key",
                baseUrl: "https://openrouter.test/api/v1",
                model: "openai/whisper-large-v3",
                language: "en",
            },
        });
    });

    it("loads opt-in workspace intent resolver settings", () => {
        const config = loadBridgeConfig({
            HOME: "/home/example",
            OPENCODE_BRIDGE_WORKSPACE_ROOT: "/workspace/dev/",
            OPENCODE_BRIDGE_INTENT_RESOLVER: "1",
            OPENCODE_BRIDGE_INTENT_RESOLVER_MAX_TURNS: "6",
            OPENCODE_BRIDGE_INTENT_RESOLVER_TTL_MS: "120000",
        });

        assert.deepEqual(config.workspace, {
            root: "/workspace/dev",
        });
        assert.deepEqual(config.intentResolver, {
            enabled: true,
            maxClarificationTurns: 6,
            clarificationTtlMs: 120000,
        });
    });

    it("requires a workspace root when the intent resolver is enabled", () => {
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_INTENT_RESOLVER: "1" }),
            /OPENCODE_BRIDGE_WORKSPACE_ROOT must be set when OPENCODE_BRIDGE_INTENT_RESOLVER is enabled/,
        );
    });

    it("requires an OpenRouter key when voice transcription is enabled", () => {
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_VOICE_TRANSCRIPTION: "1" }),
            /OPENCODE_BRIDGE_OPENROUTER_API_KEY must be set when OPENCODE_BRIDGE_VOICE_TRANSCRIPTION is enabled/,
        );
    });

    it("rejects invalid Discord daemon settings", () => {
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_DISCORD_SLASH_COMMAND: "bad command" }),
            /OPENCODE_BRIDGE_DISCORD_SLASH_COMMAND must not contain whitespace/,
        );
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_DISCORD_MAX_MESSAGE_CHARS: "2000" }),
            /OPENCODE_BRIDGE_DISCORD_MAX_MESSAGE_CHARS must be an integer between 500 and 1990/,
        );
    });

    it("rejects invalid OpenCode URLs", () => {
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_OPENCODE_BASE_URL: "not a url" }),
            /OPENCODE_BRIDGE_OPENCODE_BASE_URL must be a valid URL/,
        );
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_OPENROUTER_BASE_URL: "ftp://openrouter.test" }),
            /OPENCODE_BRIDGE_OPENROUTER_BASE_URL must be a valid URL: unsupported protocol/,
        );
    });

    it("rejects invalid managed OpenCode numeric settings", () => {
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_OPENCODE_PORT: "70000" }),
            /OPENCODE_BRIDGE_OPENCODE_PORT must be an integer between 1 and 65535/,
        );
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_OPENCODE_STARTUP_TIMEOUT_MS: "0" }),
            /OPENCODE_BRIDGE_OPENCODE_STARTUP_TIMEOUT_MS must be an integer greater than 0/,
        );
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_VOICE_MAX_AUDIO_BYTES: "0" }),
            /OPENCODE_BRIDGE_VOICE_MAX_AUDIO_BYTES must be an integer between 1 and 20971520/,
        );
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_WORKSPACE_ROOT: "relative/dev" }),
            /OPENCODE_BRIDGE_WORKSPACE_ROOT must be an absolute path/,
        );
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_INTENT_RESOLVER_MAX_TURNS: "0" }),
            /OPENCODE_BRIDGE_INTENT_RESOLVER_MAX_TURNS must be an integer between 1 and 10/,
        );
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_INTENT_RESOLVER_TTL_MS: "999" }),
            /OPENCODE_BRIDGE_INTENT_RESOLVER_TTL_MS must be an integer between 1000 and 86400000/,
        );
    });

    it("requires HOME when no state root is configured", () => {
        assert.throws(() => loadBridgeConfig({}), /HOME must be set/);
    });
});
