import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TelegramBotApiClient, TelegramBotApiError, chunkTelegramText } from "../src/telegram.js";

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
                    text: "/oc status",
                },
            },
        ]);
    });

    it("sends text messages with optional thread IDs", async () => {
        const { client, requests } = createClient([{ ok: true, result: { message_id: 10 } }]);

        await client.sendMessage({ chatID: "123", threadID: "42", text: "hello" });

        assert.equal(requests[0]?.method, "sendMessage");
        assert.deepEqual(requests[0]?.body, {
            chat_id: "123",
            message_thread_id: 42,
            text: "hello",
            link_preview_options: { is_disabled: true },
        });
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
