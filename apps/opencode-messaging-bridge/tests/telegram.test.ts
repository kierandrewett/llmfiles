import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    TELEGRAM_BRIDGE_BOT_COMMANDS,
    TELEGRAM_MARKDOWN_PARSE_MODE,
    TelegramBotApiClient,
    TelegramBotApiError,
    chunkTelegramText,
    escapeTelegramMarkdown,
} from "../src/telegram.js";

describe("chunkTelegramText", () => {
    it("keeps short messages unchanged", () => {
        assert.deepEqual(chunkTelegramText("hello", 4096), ["hello"]);
    });

    it("chunks long messages below the Telegram sendMessage limit", () => {
        assert.deepEqual(chunkTelegramText("abcdef", 3), ["abc", "def"]);
    });

    it("returns a visible placeholder for empty messages", () => {
        assert.deepEqual(chunkTelegramText("", 4096), ["(empty message)"]);
    });
});

describe("TelegramBotApiClient", () => {
    it("long-polls updates and normalises platform IDs to strings", async () => {
        const { client, requests } = createClient([
            {
                ok: true,
                result: [
                    {
                        update_id: 100,
                        message: {
                            message_id: 7,
                            message_thread_id: 42,
                            from: { id: 1234567890123, is_bot: false, first_name: "Kieran" },
                            chat: { id: -1009876543210, type: "supergroup", title: "Bridge" },
                            text: "/oc status",
                        },
                    },
                ],
            },
        ]);

        const updates = await client.getUpdates({ offset: 99, timeoutSeconds: 30, allowedUpdates: ["message"] });

        assert.equal(requests[0]?.method, "getUpdates");
        assert.deepEqual(requests[0]?.body, { offset: 99, timeout: 30, allowed_updates: ["message"] });
        assert.deepEqual(updates, [
            {
                updateID: 100,
                message: {
                    messageID: 7,
                    threadID: "42",
                    userID: "1234567890123",
                    chatID: "-1009876543210",
                    chatType: "supergroup",
                    text: "/oc status",
                },
            },
        ]);
    });

    it("normalises Telegram voice messages into audio attachments", async () => {
        const { client } = createClient([
            {
                ok: true,
                result: [
                    {
                        update_id: 100,
                        message: {
                            message_id: 7,
                            from: { id: 1234567890123, is_bot: false, first_name: "Kieran" },
                            chat: { id: -1009876543210, type: "supergroup", title: "Bridge" },
                            voice: {
                                file_id: "voice-file-id",
                                file_unique_id: "voice-unique-id",
                                duration: 4,
                                mime_type: "audio/ogg",
                                file_size: 1234,
                            },
                        },
                    },
                ],
            },
        ]);

        const updates = await client.getUpdates();

        assert.deepEqual(updates[0]?.message?.audio, {
            kind: "voice",
            fileID: "voice-file-id",
            fileName: null,
            fileSize: 1234,
            mimeType: "audio/ogg",
        });
    });

    it("sends text messages with optional thread IDs", async () => {
        const { client, requests } = createClient([{ ok: true, result: { message_id: 10 } }]);

        const sent = await client.sendMessage({
            chatID: "123",
            threadID: "42",
            text: "*hello*",
            parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
        });

        assert.equal(requests[0]?.method, "sendMessage");
        assert.deepEqual(requests[0]?.body, {
            chat_id: "123",
            message_thread_id: 42,
            text: "*hello*",
            parse_mode: "MarkdownV2",
            link_preview_options: { is_disabled: true },
        });
        assert.deepEqual(sent, { messageID: 10 });
    });

    it("creates forum topics and normalises the returned thread ID", async () => {
        const { client, requests } = createClient([
            {
                ok: true,
                result: {
                    message_thread_id: 777,
                    name: "New work",
                    icon_color: 7322096,
                },
            },
        ]);

        const topic = await client.createForumTopic({ chatID: "-100123", name: "New work" });

        assert.equal(requests[0]?.method, "createForumTopic");
        assert.deepEqual(requests[0]?.body, { chat_id: "-100123", name: "New work" });
        assert.deepEqual(topic, {
            messageThreadID: "777",
            name: "New work",
            iconColor: 7322096,
            iconCustomEmojiID: null,
            isNameImplicit: false,
        });
    });

    it("streams private chat drafts", async () => {
        const { client, requests } = createClient([{ ok: true, result: true }]);

        await client.sendMessageDraft({
            chatID: "123",
            threadID: "42",
            draftID: 99,
            text: "streaming",
            parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
        });

        assert.equal(requests[0]?.method, "sendMessageDraft");
        assert.deepEqual(requests[0]?.body, {
            chat_id: 123,
            message_thread_id: 42,
            draft_id: 99,
            text: "streaming",
            parse_mode: "MarkdownV2",
        });
    });

    it("edits bot messages with MarkdownV2 formatting", async () => {
        const { client, requests } = createClient([{ ok: true, result: { message_id: 10 } }]);

        const edited = await client.editMessageText({
            chatID: "123",
            messageID: 10,
            text: "updated",
            parseMode: TELEGRAM_MARKDOWN_PARSE_MODE,
        });

        assert.equal(requests[0]?.method, "editMessageText");
        assert.deepEqual(requests[0]?.body, {
            chat_id: "123",
            message_id: 10,
            text: "updated",
            parse_mode: "MarkdownV2",
            link_preview_options: { is_disabled: true },
        });
        assert.deepEqual(edited, { messageID: 10 });
    });

    it("registers the Telegram command menu", async () => {
        const { client, requests } = createClient([{ ok: true, result: true }]);

        await client.setMyCommands({ commands: TELEGRAM_BRIDGE_BOT_COMMANDS });

        assert.equal(requests[0]?.method, "setMyCommands");
        assert.deepEqual(requests[0]?.body, { commands: TELEGRAM_BRIDGE_BOT_COMMANDS });
    });

    it("sets message reactions", async () => {
        const { client, requests } = createClient([{ ok: true, result: true }]);

        await client.setMessageReaction({ chatID: "123", messageID: 10, emoji: "\u{1F44D}", isBig: true });

        assert.equal(requests[0]?.method, "setMessageReaction");
        assert.deepEqual(requests[0]?.body, {
            chat_id: "123",
            message_id: 10,
            reaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
            is_big: true,
        });
    });

    it("escapes plain text for Telegram MarkdownV2", () => {
        assert.equal(escapeTelegramMarkdown("[bridge] value_1: a+b."), "\\[bridge\\] value\\_1: a\\+b\\.");
    });

    it("sends typing chat actions", async () => {
        const { client, requests } = createClient([{ ok: true, result: true }]);

        await client.sendChatAction({ chatID: "123", threadID: null, action: "typing" });

        assert.equal(requests[0]?.method, "sendChatAction");
        assert.deepEqual(requests[0]?.body, { chat_id: "123", action: "typing" });
    });

    it("throws structured API errors without leaking the bot token", async () => {
        const { client } = createClient([{ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } }]);

        await assert.rejects(
            () => client.sendMessage({ chatID: "123", threadID: null, text: "hello" }),
            (error) => {
                assert.equal(error instanceof TelegramBotApiError, true);
                assert.equal((error as TelegramBotApiError).errorCode, 429);
                assert.equal((error as TelegramBotApiError).retryAfterSeconds, 5);
                assert.equal(String((error as Error).message).includes("bot-token"), false);
                return true;
            },
        );
    });
});

interface CapturedTelegramRequest {
    method: string;
    body: unknown;
}

function createClient(responses: unknown[]): { client: TelegramBotApiClient; requests: CapturedTelegramRequest[] } {
    const requests: CapturedTelegramRequest[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        requests.push({ method: url.pathname.split("/").at(-1) ?? "", body: JSON.parse(String(init.body)) as unknown });
        const body = responses.shift();

        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    return {
        client: new TelegramBotApiClient({ botToken: "bot-token", fetch: fetcher }),
        requests,
    };
}
