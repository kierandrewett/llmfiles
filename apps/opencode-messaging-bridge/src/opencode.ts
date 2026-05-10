export interface OpenCodeHealth {
    healthy: boolean;
    version: string;
}

export interface OpenCodeSessionTime {
    created?: number;
    updated?: number;
}

export interface OpenCodeSession {
    id: string;
    title: string | null;
    directory: string | null;
    time: OpenCodeSessionTime | null;
}

export interface ListSessionsOptions {
    limit?: number;
    directory?: string;
}

export interface CreateSessionInput {
    title?: string;
    directory?: string;
}

export interface GetSessionInput {
    sessionID: string;
    directory?: string;
}

export interface SendPromptInput {
    sessionID: string;
    text: string;
    directory?: string;
}

export interface OpenCodeJsonSchemaFormat {
    type: "json_schema";
    schema: Record<string, unknown>;
    retryCount?: number;
}

export interface OpenCodeTextFormat {
    type: "text";
}

export type OpenCodeOutputFormat = OpenCodeJsonSchemaFormat | OpenCodeTextFormat;

export interface SendPromptAndWaitInput extends SendPromptInput {
    format?: OpenCodeOutputFormat;
}

export interface OpenCodeMessageInfo {
    id: string | null;
    sessionID: string | null;
    structuredOutput: unknown;
    error: unknown;
}

export interface OpenCodeMessagePart {
    type: string;
    text: string | null;
}

export interface OpenCodeMessageResponse {
    info: OpenCodeMessageInfo;
    parts: OpenCodeMessagePart[];
}

export interface AbortSessionInput {
    sessionID: string;
    directory?: string;
}

export type OpenCodePermissionResponse = "once" | "always" | "reject";

export interface ReplyPermissionInput {
    sessionID?: string;
    permissionID: string;
    response: OpenCodePermissionResponse;
    directory?: string;
    message?: string;
}

export interface OpenCodeEvent {
    type: string;
    properties: Record<string, unknown>;
}

export interface SubscribeEventsInput {
    signal?: AbortSignal;
}

export class OpenCodeHttpError extends Error {
    readonly status: number;
    readonly body: string;

    constructor(message: string, status: number, body: string) {
        super(message);
        this.name = "OpenCodeHttpError";
        this.status = status;
        this.body = body;
    }
}

export class OpenCodeHttpClient {
    private readonly baseUrl: string;
    private readonly fetcher: typeof fetch;

    constructor(options: { baseUrl: string; fetch?: typeof fetch }) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    async health(): Promise<OpenCodeHealth> {
        const value = await this.requestJson("/global/health", { method: "GET" });
        const record = requireRecord(value, "OpenCode health response");

        return {
            healthy: requireBoolean(record.healthy, "OpenCode health response.healthy"),
            version: requireString(record.version, "OpenCode health response.version"),
        };
    }

    async listSessions(options: ListSessionsOptions = {}): Promise<OpenCodeSession[]> {
        const value = await this.requestJson("/session", {
            method: "GET",
            query: {
                directory: options.directory,
                limit: options.limit,
            },
        });

        if (!Array.isArray(value)) {
            throw new Error("OpenCode session list response must be an array");
        }

        return value.map((entry, index) => parseSession(entry, `OpenCode session list response[${index}]`));
    }

    async createSession(input: CreateSessionInput = {}): Promise<OpenCodeSession> {
        const body: Record<string, string> = {};
        if (input.title) {
            body.title = input.title;
        }

        const value = await this.requestJson("/session", {
            method: "POST",
            query: {
                directory: input.directory,
            },
            body,
        });

        return parseSession(value, "OpenCode create session response");
    }

    async getSession(input: GetSessionInput): Promise<OpenCodeSession> {
        const value = await this.requestJson(`/session/${encodeURIComponent(input.sessionID)}`, {
            method: "GET",
            query: {
                directory: input.directory,
            },
        });

        return parseSession(value, "OpenCode get session response");
    }

    async sendPrompt(input: SendPromptInput): Promise<void> {
        await this.requestJson(`/session/${encodeURIComponent(input.sessionID)}/prompt_async`, {
            method: "POST",
            query: {
                directory: input.directory,
            },
            body: {
                parts: [{ type: "text", text: input.text }],
            },
        });
    }

    async sendPromptAndWait(input: SendPromptAndWaitInput): Promise<OpenCodeMessageResponse> {
        const body: Record<string, unknown> = {
            parts: [{ type: "text", text: input.text }],
        };
        if (input.format) {
            body.format = input.format;
        }

        const value = await this.requestJson(`/session/${encodeURIComponent(input.sessionID)}/message`, {
            method: "POST",
            query: {
                directory: input.directory,
            },
            body,
        });

        return parseMessageResponse(value, "OpenCode message response");
    }

    async abortSession(input: AbortSessionInput): Promise<void> {
        await this.requestJson(`/session/${encodeURIComponent(input.sessionID)}/abort`, {
            method: "POST",
            query: {
                directory: input.directory,
            },
        });
    }

    async replyPermission(input: ReplyPermissionInput): Promise<void> {
        try {
            await this.requestJson(`/permission/${encodeURIComponent(input.permissionID)}/reply`, {
                method: "POST",
                query: {
                    directory: input.directory,
                },
                body: permissionReplyBody(input),
            });
            return;
        } catch (error) {
            if (!(error instanceof OpenCodeHttpError) || error.status !== 404 || !input.sessionID) {
                throw error;
            }
        }

        await this.requestJson(
            `/session/${encodeURIComponent(input.sessionID)}/permissions/${encodeURIComponent(input.permissionID)}`,
            {
                method: "POST",
                query: {
                    directory: input.directory,
                },
                body: {
                    response: input.response,
                },
            },
        );
    }

    async subscribeEvents(input: SubscribeEventsInput = {}): Promise<AsyncIterable<OpenCodeEvent>> {
        const requestInit: RequestInit = {
            method: "GET",
            headers: { accept: "text/event-stream" },
        };
        if (input.signal) {
            requestInit.signal = input.signal;
        }

        const response = await this.fetcher(this.url("/event"), requestInit);
        if (!response.ok) {
            const text = await response.text();
            throw new OpenCodeHttpError(`OpenCode request failed with HTTP ${response.status}`, response.status, text);
        }
        if (!response.body) {
            throw new Error("OpenCode event stream response did not include a body");
        }

        return parseOpenCodeEventStream(response.body);
    }

    private async requestJson(route: string, options: RequestOptions): Promise<unknown> {
        const requestInit: RequestInit = {
            method: options.method,
        };

        if (options.body) {
            requestInit.headers = { "content-type": "application/json" };
            requestInit.body = JSON.stringify(options.body);
        }

        const response = await this.fetcher(this.url(route, options.query), requestInit);
        const text = await response.text();

        if (!response.ok) {
            throw new OpenCodeHttpError(`OpenCode request failed with HTTP ${response.status}`, response.status, text);
        }

        if (text.length === 0) {
            return null;
        }

        return JSON.parse(text) as unknown;
    }

    private url(route: string, query: Record<string, string | number | undefined> = {}): string {
        const url = new URL(`${this.baseUrl}${route}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }

        return url.toString();
    }
}

interface RequestOptions {
    method: "GET" | "POST";
    query?: Record<string, string | number | undefined>;
    body?: Record<string, unknown>;
}

function permissionReplyBody(input: ReplyPermissionInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
        reply: input.response,
    };
    if (input.message) {
        body.message = input.message;
    }

    return body;
}

function parseSession(value: unknown, source: string): OpenCodeSession {
    const record = requireRecord(value, source);

    return {
        id: requireString(record.id, `${source}.id`),
        title: readNullableString(record.title, `${source}.title`),
        directory: readNullableString(record.directory, `${source}.directory`),
        time: parseSessionTime(record.time, `${source}.time`),
    };
}

function parseSessionTime(value: unknown, source: string): OpenCodeSessionTime | null {
    if (value === undefined || value === null) {
        return null;
    }

    const record = requireRecord(value, source);
    const time: OpenCodeSessionTime = {};
    if (record.created !== undefined) {
        time.created = requireFiniteNumber(record.created, `${source}.created`);
    }
    if (record.updated !== undefined) {
        time.updated = requireFiniteNumber(record.updated, `${source}.updated`);
    }

    return time;
}

function parseMessageResponse(value: unknown, source: string): OpenCodeMessageResponse {
    const record = requireRecord(value, source);
    const info = requireRecord(record.info, `${source}.info`);

    return {
        info: {
            id: readNullableString(info.id, `${source}.info.id`),
            sessionID: readNullableString(info.sessionID ?? info.sessionId, `${source}.info.sessionID`),
            structuredOutput: info.structured_output ?? info.structuredOutput ?? null,
            error: info.error ?? null,
        },
        parts: requireArray(record.parts, `${source}.parts`).map((entry, index) => parseMessagePart(entry, `${source}.parts[${String(index)}]`)),
    };
}

function parseMessagePart(value: unknown, source: string): OpenCodeMessagePart {
    const record = requireRecord(value, source);

    return {
        type: requireString(record.type, `${source}.type`),
        text: readText(record.text, `${source}.text`),
    };
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${source} must be an object`);
    }

    return value as Record<string, unknown>;
}

function requireArray(value: unknown, source: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${source} must be an array`);
    }

    return value;
}

function requireString(value: unknown, source: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${source} must be a non-empty string`);
    }

    return value;
}

function readNullableString(value: unknown, source: string): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    return requireString(value, source);
}

function readText(value: unknown, source: string): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new Error(`${source} must be a string`);
    }

    return value;
}

function requireBoolean(value: unknown, source: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${source} must be a boolean`);
    }

    return value;
}

function requireFiniteNumber(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${source} must be a finite number`);
    }

    return value;
}

async function* parseOpenCodeEventStream(stream: ReadableStream<Uint8Array>): AsyncIterable<OpenCodeEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                buffer += decoder.decode();
                yield* parseCompleteSseBuffer(buffer);
                return;
            }

            buffer += decoder.decode(value, { stream: true });
            const split = splitCompleteSseBuffer(buffer);
            buffer = split.remainder;
            yield* parseCompleteSseBuffer(split.complete);
        }
    } finally {
        reader.releaseLock();
    }
}

function splitCompleteSseBuffer(buffer: string): { complete: string; remainder: string } {
    const normalised = buffer.replace(/\r\n/g, "\n");
    const lastBoundary = normalised.lastIndexOf("\n\n");
    if (lastBoundary === -1) {
        return { complete: "", remainder: normalised };
    }

    return {
        complete: normalised.slice(0, lastBoundary + 2),
        remainder: normalised.slice(lastBoundary + 2),
    };
}

function* parseCompleteSseBuffer(buffer: string): Iterable<OpenCodeEvent> {
    for (const block of buffer.split("\n\n")) {
        const data = sseData(block);
        if (!data) {
            continue;
        }

        yield parseOpenCodeEventPayload(JSON.parse(data) as unknown);
    }
}

function sseData(block: string): string | null {
    const lines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));

    return lines.length === 0 ? null : lines.join("\n");
}

function parseOpenCodeEventPayload(value: unknown): OpenCodeEvent {
    const record = requireRecord(value, "OpenCode event payload");
    const payload = isRecord(record.payload) ? record.payload : record;

    return {
        type: requireString(payload.type, "OpenCode event payload.type"),
        properties: isRecord(payload.properties) ? payload.properties : {},
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
