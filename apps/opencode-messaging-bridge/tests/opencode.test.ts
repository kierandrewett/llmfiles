import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenCodeHttpError, OpenCodeHttpClient } from "../src/opencode.js";

describe("OpenCodeHttpClient", () => {
    it("checks server health", async () => {
        const { client, requests } = createClient([{ healthy: true, version: "1.3.17" }]);

        const health = await client.health();

        assert.deepEqual(health, { healthy: true, version: "1.3.17" });
        assert.equal(requests[0]?.url, "http://127.0.0.1:4096/global/health");
        assert.equal(requests[0]?.init.method, "GET");
    });

    it("lists sessions with a limit", async () => {
        const { client, requests } = createClient([
            [
                {
                    id: "ses_abc",
                    title: "Example",
                    directory: "/home/kieran/dev/lifeos-scrubbed",
                    time: { created: 1, updated: 2 },
                },
            ],
        ]);

        const sessions = await client.listSessions({ limit: 20 });

        assert.equal(requests[0]?.url, "http://127.0.0.1:4096/session?limit=20");
        assert.deepEqual(sessions, [
            {
                id: "ses_abc",
                title: "Example",
                directory: "/home/kieran/dev/lifeos-scrubbed",
                time: { created: 1, updated: 2 },
            },
        ]);
    });

    it("creates sessions with title and directory", async () => {
        const { client, requests } = createClient([{ id: "ses_new", title: "New session" }]);

        const session = await client.createSession({ title: "New session", directory: "/tmp/project" });

        assert.equal(requests[0]?.url, "http://127.0.0.1:4096/session?directory=%2Ftmp%2Fproject");
        assert.equal(requests[0]?.init.method, "POST");
        assert.equal(requests[0]?.init.body, JSON.stringify({ title: "New session" }));
        assert.deepEqual(session, { id: "ses_new", title: "New session", directory: null, time: null });
    });

    it("gets sessions by ID", async () => {
        const { client, requests } = createClient([{ id: "ses_abc", title: "Example" }]);

        const session = await client.getSession({ sessionID: "ses_abc" });

        assert.equal(requests[0]?.url, "http://127.0.0.1:4096/session/ses_abc");
        assert.equal(requests[0]?.init.method, "GET");
        assert.deepEqual(session, { id: "ses_abc", title: "Example", directory: null, time: null });
    });

    it("sends prompts asynchronously", async () => {
        const { client, requests } = createClient([null]);

        await client.sendPrompt({ sessionID: "ses_abc", text: "hello" });

        assert.equal(requests[0]?.url, "http://127.0.0.1:4096/session/ses_abc/prompt_async");
        assert.equal(requests[0]?.init.method, "POST");
        assert.equal(requests[0]?.init.body, JSON.stringify({ parts: [{ type: "text", text: "hello" }] }));
    });

    it("aborts sessions", async () => {
        const { client, requests } = createClient([true]);

        await client.abortSession({ sessionID: "ses_abc" });

        assert.equal(requests[0]?.url, "http://127.0.0.1:4096/session/ses_abc/abort");
        assert.equal(requests[0]?.init.method, "POST");
    });

    it("throws structured errors for failed requests", async () => {
        const { client } = createClient([{ error: "nope" }], 500);

        await assert.rejects(
            () => client.health(),
            (error) => error instanceof OpenCodeHttpError && error.status === 500 && error.body === '{"error":"nope"}',
        );
    });

    it("subscribes to the OpenCode event stream", async () => {
        const directEvent = { type: "server.connected", properties: {} };
        const wrappedEvent = {
            directory: "/tmp/project",
            payload: {
                type: "message.part.updated",
                properties: {
                    part: {
                        id: "part_1",
                        sessionID: "ses_abc",
                        type: "text",
                        text: "hello",
                    },
                },
            },
        };
        const { client, requests } = createSseClient([
            `event: server.connected\ndata: ${JSON.stringify(directEvent)}\n\n`,
            `data: ${JSON.stringify(wrappedEvent)}\n\n`,
        ].join(""));

        const events = await client.subscribeEvents();
        const received = [];
        for await (const event of events) {
            received.push(event);
        }

        assert.equal(requests[0]?.url, "http://127.0.0.1:4096/event");
        assert.equal(requests[0]?.init.method, "GET");
        assert.deepEqual(received, [
            { type: "server.connected", properties: {} },
            {
                type: "message.part.updated",
                properties: {
                    part: {
                        id: "part_1",
                        sessionID: "ses_abc",
                        type: "text",
                        text: "hello",
                    },
                },
            },
        ]);
    });
});

interface CapturedRequest {
    url: string;
    init: RequestInit;
}

function createClient(responses: unknown[], status = 200): { client: OpenCodeHttpClient; requests: CapturedRequest[] } {
    const requests: CapturedRequest[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
        requests.push({ url: String(input), init });
        const body = responses.shift();
        return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        });
    };

    return {
        client: new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096", fetch: fetcher }),
        requests,
    };
}

function createSseClient(body: string): { client: OpenCodeHttpClient; requests: CapturedRequest[] } {
    const requests: CapturedRequest[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
        requests.push({ url: String(input), init });
        return new Response(encodeStream(body), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
    };

    return {
        client: new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096", fetch: fetcher }),
        requests,
    };
}

function encodeStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}
