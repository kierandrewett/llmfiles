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

export interface AbortSessionInput {
    sessionID: string;
    directory?: string;
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

    async abortSession(input: AbortSessionInput): Promise<void> {
        await this.requestJson(`/session/${encodeURIComponent(input.sessionID)}/abort`, {
            method: "POST",
            query: {
                directory: input.directory,
            },
        });
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

function requireRecord(value: unknown, source: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${source} must be an object`);
    }

    return value as Record<string, unknown>;
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
