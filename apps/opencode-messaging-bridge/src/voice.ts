export type OpenRouterAudioFormat = "wav" | "mp3" | "flac" | "m4a" | "ogg" | "webm" | "aac";

export interface AudioMetadata {
    mimeType?: string | null;
    fileName?: string | null;
}

export interface TranscribeAudioInput {
    data: Uint8Array;
    format: OpenRouterAudioFormat;
}

export interface TranscriptionResult {
    text: string;
    usage?: Record<string, unknown>;
}

export interface OpenRouterTranscriptionClientOptions {
    apiKey: string;
    baseUrl: string;
    model: string;
    language: string | null;
    fetch?: typeof fetch;
}

export class OpenRouterTranscriptionError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(`OpenRouter transcription failed with HTTP ${String(status)}: ${message}`);
        this.name = "OpenRouterTranscriptionError";
        this.status = status;
    }
}

export class OpenRouterTranscriptionClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly language: string | null;
    private readonly fetcher: typeof fetch;

    constructor(options: OpenRouterTranscriptionClientOptions) {
        this.apiKey = options.apiKey;
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.model = options.model;
        this.language = options.language;
        this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    async transcribe(input: TranscribeAudioInput): Promise<TranscriptionResult> {
        const body: Record<string, unknown> = {
            model: this.model,
            input_audio: {
                data: Buffer.from(input.data).toString("base64"),
                format: input.format,
            },
        };
        if (this.language !== null) {
            body.language = this.language;
        }

        const response = await this.fetcher(`${this.baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${this.apiKey}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok) {
            throw new OpenRouterTranscriptionError(response.status, openRouterErrorMessage(text) ?? `HTTP ${String(response.status)}`);
        }

        return parseTranscriptionResponse(text);
    }
}

export async function downloadRemoteAudio(input: { url: string; maxBytes: number; fetch?: typeof fetch }): Promise<Uint8Array> {
    const url = parseHttpsAudioUrl(input.url);
    const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetcher(url);
    if (!response.ok) {
        throw new Error(`audio download failed with HTTP ${String(response.status)}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
        const bytes = Number(contentLength);
        if (Number.isFinite(bytes) && bytes > input.maxBytes) {
            throw new Error(audioTooLargeMessage(input.maxBytes));
        }
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > input.maxBytes) {
        throw new Error(audioTooLargeMessage(input.maxBytes));
    }

    return new Uint8Array(buffer);
}

export function audioFormatFromMetadata(metadata: AudioMetadata): OpenRouterAudioFormat | null {
    const mimeType = metadata.mimeType?.split(";")[0]?.trim().toLowerCase();
    if (mimeType) {
        const format = formatFromMimeType(mimeType);
        if (format !== null) {
            return format;
        }
    }

    const extension = metadata.fileName?.split(".").at(-1)?.trim().toLowerCase();
    return formatFromExtension(extension ?? "");
}

export function enforceAudioSizeLimit(bytes: number | null, maxBytes: number): void {
    if (bytes !== null && bytes > maxBytes) {
        throw new Error(audioTooLargeMessage(maxBytes));
    }
}

function parseHttpsAudioUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:") {
        throw new Error("audio URL must use HTTPS");
    }

    return url.toString();
}

function audioTooLargeMessage(maxBytes: number): string {
    return `audio file is too large; maximum is ${String(maxBytes)} bytes`;
}

function formatFromMimeType(mimeType: string): OpenRouterAudioFormat | null {
    switch (mimeType) {
        case "audio/aac":
        case "audio/x-aac":
            return "aac";
        case "audio/flac":
        case "audio/x-flac":
            return "flac";
        case "audio/m4a":
        case "audio/mp4":
        case "audio/x-m4a":
            return "m4a";
        case "audio/mpeg":
        case "audio/mp3":
            return "mp3";
        case "audio/ogg":
        case "audio/oga":
            return "ogg";
        case "audio/wav":
        case "audio/wave":
        case "audio/x-wav":
            return "wav";
        case "audio/webm":
            return "webm";
        default:
            return null;
    }
}

function formatFromExtension(extension: string): OpenRouterAudioFormat | null {
    switch (extension) {
        case "aac":
        case "flac":
        case "m4a":
        case "mp3":
        case "ogg":
        case "wav":
        case "webm":
            return extension;
        case "oga":
            return "ogg";
        default:
            return null;
    }
}

function parseTranscriptionResponse(text: string): TranscriptionResult {
    const payload = parseJsonObject(text, "OpenRouter transcription response");
    const transcriptionText = payload.text;
    if (typeof transcriptionText !== "string") {
        throw new Error("OpenRouter transcription response.text must be a string");
    }

    const result: TranscriptionResult = { text: transcriptionText };
    if (isRecord(payload.usage)) {
        result.usage = payload.usage;
    }

    return result;
}

function openRouterErrorMessage(text: string): string | null {
    try {
        const payload = parseJsonObject(text, "OpenRouter error response");
        if (isRecord(payload.error) && typeof payload.error.message === "string") {
            return payload.error.message;
        }
    } catch {
        return text.trim() || null;
    }

    return text.trim() || null;
}

function parseJsonObject(text: string, source: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!isRecord(parsed)) {
            throw new Error("must be an object");
        }

        return parsed;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${source} must be valid JSON: ${reason}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
