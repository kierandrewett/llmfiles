const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramUpdate {
    updateID: number;
    message: TelegramMessage | null;
}

export interface TelegramMessage {
    messageID: number;
    threadID: string | null;
    userID: string | null;
    chatID: string;
    text: string | null;
}

export interface GetUpdatesOptions {
    offset?: number;
    timeoutSeconds?: number;
    allowedUpdates?: string[];
}

export interface SendMessageInput {
    chatID: string;
    threadID: string | null;
    text: string;
}

export interface SendChatActionInput {
    chatID: string;
    threadID: string | null;
    action: "typing";
}

export class TelegramBotApiError extends Error {
    readonly method: string;
    readonly errorCode: number | null;
    readonly retryAfterSeconds: number | null;

    constructor(method: string, description: string, errorCode: number | null, retryAfterSeconds: number | null) {
        super(`Telegram ${method} failed: ${description}`);
        this.name = "TelegramBotApiError";
        this.method = method;
        this.errorCode = errorCode;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

export class TelegramBotApiClient {
    private readonly botToken: string;
    private readonly baseUrl: string;
    private readonly fetcher: typeof fetch;

    constructor(options: { botToken: string; baseUrl?: string; fetch?: typeof fetch }) {
        this.botToken = options.botToken;
        this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? TELEGRAM_API_BASE_URL;
        this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    async getUpdates(options: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
        const body: Record<string, unknown> = {};
        if (options.offset !== undefined) {
            body.offset = options.offset;
        }
        if (options.timeoutSeconds !== undefined) {
            body.timeout = options.timeoutSeconds;
        }
        if (options.allowedUpdates) {
            body.allowed_updates = options.allowedUpdates;
        }

        const result = await this.request("getUpdates", body);
        if (!Array.isArray(result)) {
            throw new Error("Telegram getUpdates result must be an array");
        }

        return result.map((entry, index) => parseUpdate(entry, `Telegram getUpdates result[${index}]`));
    }

    async sendMessage(input: SendMessageInput): Promise<void> {
        await this.request("sendMessage", telegramMessageBody(input));
    }

    async sendChatAction(input: SendChatActionInput): Promise<void> {
        await this.request("sendChatAction", telegramChatActionBody(input));
    }

    private async request(method: string, body: Record<string, unknown>): Promise<unknown> {
        const response = await this.fetcher(`${this.baseUrl}/bot${this.botToken}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        const payload = parseTelegramResponse(text, method);

        if (!response.ok || payload.ok === false) {
            const description = typeof payload.description === "string" ? payload.description : `HTTP ${response.status}`;
            const errorCode = typeof payload.error_code === "number" ? payload.error_code : response.status;
            const retryAfterSeconds = parseRetryAfter(payload.parameters);
            throw new TelegramBotApiError(method, description, errorCode, retryAfterSeconds);
        }

        return payload.result;
    }
}

export function chunkTelegramText(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
    if (text.length === 0) {
        return ["(empty message)"];
    }

    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += limit) {
        chunks.push(text.slice(index, index + limit));
    }

    return chunks;
}

export function telegramMessageBody(input: SendMessageInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
        chat_id: input.chatID,
        text: input.text,
        link_preview_options: { is_disabled: true },
    };

    if (input.threadID !== null) {
        body.message_thread_id = Number(input.threadID);
    }

    return body;
}

export function telegramChatActionBody(input: SendChatActionInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
        chat_id: input.chatID,
        action: input.action,
    };

    if (input.threadID !== null) {
        body.message_thread_id = Number(input.threadID);
    }

    return body;
}

function parseUpdate(value: unknown, source: string): TelegramUpdate {
    const record = requireRecord(value, source);

    return {
        updateID: requireNumber(record.update_id, `${source}.update_id`),
        message: record.message === undefined ? null : parseMessage(record.message, `${source}.message`),
    };
}

function parseMessage(value: unknown, source: string): TelegramMessage {
    const record = requireRecord(value, source);
    const chat = requireRecord(record.chat, `${source}.chat`);
    const from = record.from === undefined ? null : requireRecord(record.from, `${source}.from`);

    return {
        messageID: requireNumber(record.message_id, `${source}.message_id`),
        threadID: record.message_thread_id === undefined ? null : String(requireNumber(record.message_thread_id, `${source}.message_thread_id`)),
        userID: from === null ? null : String(requireNumber(from.id, `${source}.from.id`)),
        chatID: String(requireNumber(chat.id, `${source}.chat.id`)),
        text: record.text === undefined ? null : requireString(record.text, `${source}.text`),
    };
}

function parseTelegramResponse(text: string, method: string): Record<string, unknown> {
    try {
        return requireRecord(JSON.parse(text) as unknown, `Telegram ${method} response`);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TelegramBotApiError(method, `invalid JSON response: ${reason}`, null, null);
    }
}

function parseRetryAfter(parameters: unknown): number | null {
    if (!isRecord(parameters)) {
        return null;
    }

    const retryAfter = parameters.retry_after;
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : null;
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`${source} must be an object`);
    }

    return value;
}

function requireNumber(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${source} must be a finite number`);
    }

    return value;
}

function requireString(value: unknown, source: string): string {
    if (typeof value !== "string") {
        throw new Error(`${source} must be a string`);
    }

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
