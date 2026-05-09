import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    DiscordBotApiClient,
    chunkDiscordText,
    discordSlashCommandDefinition,
    parseDiscordInteraction,
    parseDiscordMessage,
} from "../src/discord.js";

describe("chunkDiscordText", () => {
    it("splits long content without exceeding the limit", () => {
        const chunks = chunkDiscordText(`hello ${"world ".repeat(20)}`, 30);

        assert.ok(chunks.length > 1);
        assert.ok(chunks.every((chunk) => chunk.length <= 30));
        assert.equal(chunks.join(" ").replace(/\s+/g, " "), `hello ${"world ".repeat(20)}`.trim());
    });
});

describe("DiscordBotApiClient", () => {
    it("sends channel messages with mentions disabled", async () => {
        const fetcher = createFetch([{ id: "message-id" }]);
        const client = new DiscordBotApiClient({ botToken: "bot-token", baseUrl: "https://discord.test/api/v10", fetch: fetcher.fetch });

        await client.sendMessage({ channelID: "123", content: "hello <@456>" });

        assert.equal(fetcher.calls[0]?.url, "https://discord.test/api/v10/channels/123/messages");
        assert.equal(fetcher.calls[0]?.init.method, "POST");
        assert.equal(fetcher.calls[0]?.headers.authorization, "Bot bot-token");
        assert.deepEqual(fetcher.calls[0]?.jsonBody, {
            content: "hello <@456>",
            allowed_mentions: { parse: [] },
        });
    });

    it("responds to interactions without bot authorization", async () => {
        const fetcher = createFetch([null]);
        const client = new DiscordBotApiClient({ botToken: "bot-token", baseUrl: "https://discord.test/api/v10", fetch: fetcher.fetch });

        await client.sendInteractionMessage({
            interactionID: "interaction-id",
            interactionToken: "interaction-token",
            content: "accepted",
            ephemeral: true,
        });

        assert.equal(fetcher.calls[0]?.url, "https://discord.test/api/v10/interactions/interaction-id/interaction-token/callback");
        assert.equal(fetcher.calls[0]?.headers.authorization, undefined);
        assert.deepEqual(fetcher.calls[0]?.jsonBody, {
            type: DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE,
            data: {
                content: "accepted",
                flags: 64,
                allowed_mentions: { parse: [] },
            },
        });
    });

    it("registers guild slash commands using the documented application command shape", async () => {
        const fetcher = createFetch([{ id: "command-id" }]);
        const client = new DiscordBotApiClient({ botToken: "bot-token", baseUrl: "https://discord.test/api/v10", fetch: fetcher.fetch });

        await client.registerSlashCommand({ applicationID: "app-id", guildID: "guild-id", name: "oc" });

        assert.equal(fetcher.calls[0]?.url, "https://discord.test/api/v10/applications/app-id/guilds/guild-id/commands");
        assert.deepEqual(fetcher.calls[0]?.jsonBody, discordSlashCommandDefinition("oc"));
    });
});

describe("Discord payload parsing", () => {
    it("parses message create payloads into daemon messages", () => {
        const message = parseDiscordMessage({
            id: "message-id",
            channel_id: "channel-id",
            guild_id: "guild-id",
            content: "!oc status",
            author: { id: "user-id", bot: false },
        });

        assert.deepEqual(message, {
            id: "message-id",
            channelID: "channel-id",
            guildID: "guild-id",
            userID: "user-id",
            authorBot: false,
            content: "!oc status",
        });
    });

    it("parses slash command interactions into daemon interactions", () => {
        const interaction = parseDiscordInteraction({
            id: "interaction-id",
            token: "interaction-token",
            type: 2,
            channel_id: "channel-id",
            guild_id: "guild-id",
            member: { user: { id: "user-id" } },
            data: {
                name: "oc",
                type: 1,
                options: [
                    {
                        name: "prompt",
                        type: 1,
                        options: [{ name: "text", type: 3, value: "hello" }],
                    },
                ],
            },
        });

        assert.equal(interaction.userID, "user-id");
        assert.equal(interaction.data?.options[0]?.name, "prompt");
        assert.equal(interaction.data?.options[0]?.options?.[0]?.value, "hello");
    });
});

interface FetchCall {
    url: string;
    init: RequestInit;
    headers: Record<string, string>;
    jsonBody: unknown;
}

function createFetch(results: unknown[]): { calls: FetchCall[]; fetch: typeof fetch } {
    const calls: FetchCall[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
        const headers = normaliseHeaders(init.headers);
        const jsonBody = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
        calls.push({ url: String(input), init, headers, jsonBody });
        const result = results.shift() ?? null;

        return new Response(result === null ? "" : JSON.stringify(result), { status: 200 });
    };

    return { calls, fetch: fetcher };
}

function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers || headers instanceof Headers || Array.isArray(headers)) {
        return {};
    }

    return headers;
}
