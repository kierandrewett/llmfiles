import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    OpenRouterTranscriptionClient,
    OpenRouterTranscriptionError,
    audioFormatFromMetadata,
    downloadRemoteAudio,
} from "../src/voice.js";

describe("audioFormatFromMetadata", () => {
    it("maps supported audio MIME types and file extensions to OpenRouter formats", () => {
        assert.equal(audioFormatFromMetadata({ mimeType: "audio/ogg; codecs=opus" }), "ogg");
        assert.equal(audioFormatFromMetadata({ mimeType: "audio/mpeg" }), "mp3");
        assert.equal(audioFormatFromMetadata({ fileName: "recording.m4a" }), "m4a");
        assert.equal(audioFormatFromMetadata({ mimeType: "application/octet-stream", fileName: "clip.webm" }), "webm");
        assert.equal(audioFormatFromMetadata({ mimeType: "text/plain", fileName: "notes.txt" }), null);
    });
});

describe("OpenRouterTranscriptionClient", () => {
    it("sends base64 audio to the official transcription endpoint", async () => {
        const fetcher = createJsonFetch([{ text: "hello from audio", usage: { seconds: 1.25, cost: 0.0001 } }]);
        const client = new OpenRouterTranscriptionClient({
            apiKey: "openrouter-key",
            baseUrl: "https://openrouter.test/api/v1",
            model: "openai/whisper-large-v3",
            language: "en",
            fetch: fetcher.fetch,
        });

        const result = await client.transcribe({ data: new Uint8Array([1, 2, 3]), format: "ogg" });

        assert.deepEqual(result, { text: "hello from audio", usage: { seconds: 1.25, cost: 0.0001 } });
        assert.equal(fetcher.calls[0]?.url, "https://openrouter.test/api/v1/audio/transcriptions");
        assert.equal(fetcher.calls[0]?.init.method, "POST");
        assert.equal(fetcher.calls[0]?.headers.authorization, "Bearer openrouter-key");
        assert.equal(fetcher.calls[0]?.headers["content-type"], "application/json");
        assert.deepEqual(fetcher.calls[0]?.jsonBody, {
            model: "openai/whisper-large-v3",
            input_audio: {
                data: "AQID",
                format: "ogg",
            },
            language: "en",
        });
    });

    it("throws structured errors without leaking the API key", async () => {
        const fetcher = createJsonFetch([{ error: { message: "invalid auth" } }], 401);
        const client = new OpenRouterTranscriptionClient({
            apiKey: "openrouter-key",
            baseUrl: "https://openrouter.test/api/v1",
            model: "openai/whisper-1",
            language: null,
            fetch: fetcher.fetch,
        });

        await assert.rejects(
            () => client.transcribe({ data: new Uint8Array([1, 2, 3]), format: "ogg" }),
            (error) => {
                assert.equal(error instanceof OpenRouterTranscriptionError, true);
                assert.equal((error as OpenRouterTranscriptionError).status, 401);
                assert.equal(String((error as Error).message).includes("openrouter-key"), false);
                return true;
            },
        );
    });
});

describe("downloadRemoteAudio", () => {
    it("downloads HTTPS audio and enforces the configured byte limit", async () => {
        const fetcher = createBinaryFetch(new Uint8Array([1, 2, 3]), { "content-length": "3" });

        const data = await downloadRemoteAudio({ url: "https://cdn.example/audio.ogg", maxBytes: 3, fetch: fetcher.fetch });

        assert.deepEqual(Array.from(data), [1, 2, 3]);
        await assert.rejects(
            () => downloadRemoteAudio({ url: "https://cdn.example/audio.ogg", maxBytes: 2, fetch: fetcher.fetch }),
            /audio file is too large/,
        );
    });

    it("rejects non-HTTPS audio URLs", async () => {
        const fetcher = createBinaryFetch(new Uint8Array([1]));

        await assert.rejects(
            () => downloadRemoteAudio({ url: "http://cdn.example/audio.ogg", maxBytes: 10, fetch: fetcher.fetch }),
            /audio URL must use HTTPS/,
        );
    });
});

interface FetchCall {
    url: string;
    init: RequestInit;
    headers: Record<string, string>;
    jsonBody: unknown;
}

function createJsonFetch(results: unknown[], status = 200): { calls: FetchCall[]; fetch: typeof fetch } {
    const calls: FetchCall[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
        const headers = normaliseHeaders(init.headers);
        const jsonBody = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
        calls.push({ url: String(input), init, headers, jsonBody });
        const result = results.shift() ?? null;

        return new Response(result === null ? "" : JSON.stringify(result), { status });
    };

    return { calls, fetch: fetcher };
}

function createBinaryFetch(data: Uint8Array, headers: Record<string, string> = {}): { fetch: typeof fetch } {
    const fetcher: typeof fetch = async () => new Response(data, { status: 200, headers });

    return { fetch: fetcher };
}

function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers || headers instanceof Headers || Array.isArray(headers)) {
        return {};
    }

    return headers;
}
