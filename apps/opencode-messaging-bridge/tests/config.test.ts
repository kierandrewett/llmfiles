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
            OPENCODE_BRIDGE_DISCORD_BOT_TOKEN: "discord-token",
            OPENCODE_BRIDGE_DISCORD_APPLICATION_ID: "app-id",
            OPENCODE_BRIDGE_DISCORD_ALLOWED_USER_IDS: "abc, def",
            OPENCODE_BRIDGE_DISCORD_CONTROL_CHANNEL_ID: "channel-id",
        });

        assert.equal(config.opencode.baseUrl, "http://localhost:4096");
        assert.equal(config.implicitReply, true);
        assert.deepEqual(config.telegram.allowedUserIDs, ["123", "456"]);
        assert.deepEqual(config.telegram.allowedChatIDs, ["999"]);
        assert.equal(config.telegram.enabled, true);
        assert.deepEqual(config.discord.allowedUserIDs, ["abc", "def"]);
        assert.equal(config.discord.enabled, true);
    });

    it("rejects invalid OpenCode URLs", () => {
        assert.throws(
            () => loadBridgeConfig({ HOME: "/home/example", OPENCODE_BRIDGE_OPENCODE_BASE_URL: "not a url" }),
            /OPENCODE_BRIDGE_OPENCODE_BASE_URL must be a valid URL/,
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
    });

    it("requires HOME when no state root is configured", () => {
        assert.throws(() => loadBridgeConfig({}), /HOME must be set/);
    });
});
