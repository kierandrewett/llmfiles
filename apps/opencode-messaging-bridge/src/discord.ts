const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_MESSAGE_LIMIT = 1850;
const DISCORD_EPHEMERAL_MESSAGE_FLAG = 1 << 6;

export const DISCORD_INTERACTION_PING = 1;
export const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
export const DISCORD_INTERACTION_RESPONSE_PONG = 1;
export const DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE = 4;
export const DISCORD_CHAT_INPUT_COMMAND = 1;
export const DISCORD_OPTION_SUBCOMMAND = 1;
export const DISCORD_OPTION_STRING = 3;

export interface DiscordMessage {
    id: string;
    channelID: string;
    guildID: string | null;
    userID: string | null;
    authorBot: boolean;
    content: string;
    attachments?: DiscordAttachment[];
}

export interface DiscordAttachment {
    id: string;
    filename: string;
    contentType: string | null;
    size: number;
    url: string;
    durationSeconds: number | null;
}

export interface DiscordInteractionOption {
    name: string;
    type: number;
    value?: string | number | boolean;
    options?: DiscordInteractionOption[];
}

export interface DiscordInteractionData {
    name: string;
    type: number;
    options: DiscordInteractionOption[];
}

export interface DiscordInteraction {
    id: string;
    token: string;
    type: number;
    channelID: string | null;
    guildID: string | null;
    userID: string | null;
    data: DiscordInteractionData | null;
}

export interface DiscordGatewayBotInfo {
    url: string;
}

export interface SendDiscordMessageInput {
    channelID: string;
    content: string;
}

export interface SendDiscordInteractionMessageInput {
    interactionID: string;
    interactionToken: string;
    content: string;
    ephemeral: boolean;
}

export interface PongDiscordInteractionInput {
    interactionID: string;
    interactionToken: string;
}

export interface RegisterDiscordSlashCommandInput {
    applicationID: string;
    guildID: string | null;
    name: string;
}

export class DiscordBotApiError extends Error {
    readonly route: string;
    readonly status: number;
    readonly body: string;

    constructor(route: string, status: number, body: string) {
        super(`Discord request to ${route} failed with HTTP ${String(status)}`);
        this.name = "DiscordBotApiError";
        this.route = route;
        this.status = status;
        this.body = body;
    }
}

export class DiscordBotApiClient {
    private readonly botToken: string;
    private readonly baseUrl: string;
    private readonly fetcher: typeof fetch;
    private readonly maxMessageChars: number;

    constructor(options: { botToken: string; baseUrl?: string; fetch?: typeof fetch; maxMessageChars?: number }) {
        this.botToken = options.botToken;
        this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? DISCORD_API_BASE_URL;
        this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.maxMessageChars = options.maxMessageChars ?? DISCORD_MESSAGE_LIMIT;
    }

    async getGatewayBot(): Promise<DiscordGatewayBotInfo> {
        const value = await this.request("/gateway/bot", { method: "GET" });
        const record = requireRecord(value, "Discord get gateway bot response");

        return {
            url: requireString(record.url, "Discord get gateway bot response.url"),
        };
    }

    async sendMessage(input: SendDiscordMessageInput): Promise<void> {
        for (const chunk of chunkDiscordText(input.content, this.maxMessageChars)) {
            await this.request(`/channels/${encodeURIComponent(input.channelID)}/messages`, {
                method: "POST",
                body: discordMessageBody(chunk),
            });
        }
    }

    async sendTyping(input: { channelID: string }): Promise<void> {
        await this.request(`/channels/${encodeURIComponent(input.channelID)}/typing`, { method: "POST" });
    }

    async sendInteractionMessage(input: SendDiscordInteractionMessageInput): Promise<void> {
        const [chunk = input.content] = chunkDiscordText(input.content, this.maxMessageChars);
        await this.request(
            `/interactions/${encodeURIComponent(input.interactionID)}/${encodeURIComponent(input.interactionToken)}/callback`,
            {
                method: "POST",
                body: {
                    type: DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE,
                    data: {
                        content: chunk,
                        flags: input.ephemeral ? DISCORD_EPHEMERAL_MESSAGE_FLAG : undefined,
                        allowed_mentions: { parse: [] },
                    },
                },
                auth: false,
            },
        );
    }

    async pongInteraction(input: PongDiscordInteractionInput): Promise<void> {
        await this.request(
            `/interactions/${encodeURIComponent(input.interactionID)}/${encodeURIComponent(input.interactionToken)}/callback`,
            {
                method: "POST",
                body: { type: DISCORD_INTERACTION_RESPONSE_PONG },
                auth: false,
            },
        );
    }

    async registerSlashCommand(input: RegisterDiscordSlashCommandInput): Promise<void> {
        const route = input.guildID
            ? `/applications/${encodeURIComponent(input.applicationID)}/guilds/${encodeURIComponent(input.guildID)}/commands`
            : `/applications/${encodeURIComponent(input.applicationID)}/commands`;

        await this.request(route, {
            method: "POST",
            body: discordSlashCommandDefinition(input.name),
        });
    }

    private async request(route: string, options: RequestOptions): Promise<unknown> {
        const headers: Record<string, string> = {};
        if (options.auth !== false) {
            headers.authorization = `Bot ${this.botToken}`;
        }
        if (options.body !== undefined) {
            headers["content-type"] = "application/json";
        }

        const requestInit: RequestInit = {
            method: options.method,
            headers,
        };
        if (options.body !== undefined) {
            requestInit.body = JSON.stringify(options.body);
        }

        const response = await this.fetcher(`${this.baseUrl}${route}`, requestInit);
        const text = await response.text();

        if (!response.ok) {
            throw new DiscordBotApiError(route, response.status, text);
        }
        if (!text) {
            return null;
        }

        return JSON.parse(text) as unknown;
    }
}

interface RequestOptions {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    auth?: boolean;
}

export function discordSlashCommandDefinition(name: string): Record<string, unknown> {
    return {
        name,
        type: DISCORD_CHAT_INPUT_COMMAND,
        description: "Remote-control the active OpenCode session.",
        options: [
            subcommand("help", "Show the Discord bridge command list."),
            subcommand("status", "Show OpenCode status and the active session."),
            subcommand("sessions", "List recent OpenCode sessions."),
            subcommand("attach", "Attach a specific session, or latest if omitted.", [
                stringOption("session_id", "Session ID or latest.", false),
            ]),
            subcommand("new", "Create and attach a new OpenCode session.", [
                stringOption("title", "Session title.", false),
            ]),
            subcommand("prompt", "Send a prompt to the active session.", [
                stringOption("text", "Prompt text.", true),
            ]),
            subcommand("reply", "Alias for prompt.", [
                stringOption("text", "Reply text.", true),
            ]),
            subcommand("abort", "Abort the active session."),
            subcommand("jobs", "List scheduled prompts for this channel."),
            subcommand("schedule", "Schedule a prompt for the active session.", [
                stringOption("text", "Schedule, for example: every 30m check status.", true),
            ]),
            subcommand("unschedule", "Remove a scheduled prompt.", [
                stringOption("job_id", "Scheduled prompt job ID.", true),
            ]),
            subcommand("run-now", "Run a scheduled prompt immediately.", [
                stringOption("job_id", "Scheduled prompt job ID.", true),
            ]),
            subcommand("allow", "Approve a pending OpenCode permission once.", [
                stringOption("permission_id", "Permission request ID.", true),
            ]),
            subcommand("always", "Approve a pending OpenCode permission for this session.", [
                stringOption("permission_id", "Permission request ID.", true),
            ]),
            subcommand("deny", "Reject a pending OpenCode permission.", [
                stringOption("permission_id", "Permission request ID.", true),
                stringOption("message", "Optional feedback for OpenCode.", false),
            ]),
        ],
    };
}

export function discordSlashCommandSignature(name: string): string {
    return JSON.stringify(discordSlashCommandDefinition(name));
}

export function chunkDiscordText(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
    const normalised = text.replace(/\r\n/g, "\n");
    if (normalised.length === 0) {
        return ["(empty message)"];
    }
    if (normalised.length <= limit) {
        return [normalised];
    }

    const chunks: string[] = [];
    let remaining = normalised;
    while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf("\n", limit);
        if (splitAt < Math.floor(limit * 0.5)) {
            splitAt = remaining.lastIndexOf(" ", limit);
        }
        if (splitAt < Math.floor(limit * 0.5)) {
            splitAt = limit;
        }

        const chunk = remaining.slice(0, splitAt).trimEnd();
        if (chunk.length > 0) {
            chunks.push(chunk);
        }
        remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}

export function discordMessageBody(content: string): Record<string, unknown> {
    return {
        content,
        allowed_mentions: { parse: [] },
    };
}

export function parseDiscordMessage(value: unknown, source = "Discord message"): DiscordMessage {
    const record = requireRecord(value, source);
    const author = readRecord(record.author, `${source}.author`);

    const message: DiscordMessage = {
        id: requireString(record.id, `${source}.id`),
        channelID: requireString(record.channel_id, `${source}.channel_id`),
        guildID: readNullableString(record.guild_id, `${source}.guild_id`),
        userID: author ? readNullableString(author.id, `${source}.author.id`) : null,
        authorBot: author?.bot === true,
        content: readString(record.content, `${source}.content`) ?? "",
    };
    const attachments = parseDiscordAttachments(record.attachments, source);
    if (attachments.length > 0) {
        message.attachments = attachments;
    }

    return message;
}

export function parseDiscordInteraction(value: unknown, source = "Discord interaction"): DiscordInteraction {
    const record = requireRecord(value, source);

    return {
        id: requireString(record.id, `${source}.id`),
        token: requireString(record.token, `${source}.token`),
        type: requireNumber(record.type, `${source}.type`),
        channelID: readNullableString(record.channel_id, `${source}.channel_id`),
        guildID: readNullableString(record.guild_id, `${source}.guild_id`),
        userID: interactionUserID(record, source),
        data: record.data === undefined ? null : parseInteractionData(record.data, `${source}.data`),
    };
}

function subcommand(name: string, description: string, options: Record<string, unknown>[] = []): Record<string, unknown> {
    return {
        name,
        description,
        type: DISCORD_OPTION_SUBCOMMAND,
        options,
    };
}

function stringOption(name: string, description: string, required: boolean): Record<string, unknown> {
    return {
        name,
        description,
        type: DISCORD_OPTION_STRING,
        required,
    };
}

function interactionUserID(record: Record<string, unknown>, source: string): string | null {
    const member = readRecord(record.member, `${source}.member`);
    const memberUser = member ? readRecord(member.user, `${source}.member.user`) : null;
    const directUser = readRecord(record.user, `${source}.user`);

    return readNullableString(memberUser?.id, `${source}.member.user.id`)
        ?? readNullableString(directUser?.id, `${source}.user.id`);
}

function parseInteractionData(value: unknown, source: string): DiscordInteractionData {
    const record = requireRecord(value, source);

    return {
        name: requireString(record.name, `${source}.name`),
        type: requireNumber(record.type, `${source}.type`),
        options: record.options === undefined
            ? []
            : requireArray(record.options, `${source}.options`).map((entry, index) => parseInteractionOption(entry, `${source}.options[${String(index)}]`)),
    };
}

function parseInteractionOption(value: unknown, source: string): DiscordInteractionOption {
    const record = requireRecord(value, source);
    const option: DiscordInteractionOption = {
        name: requireString(record.name, `${source}.name`),
        type: requireNumber(record.type, `${source}.type`),
    };
    const valueField = record.value;
    if (typeof valueField === "string" || typeof valueField === "number" || typeof valueField === "boolean") {
        option.value = valueField;
    }
    if (record.options !== undefined) {
        option.options = requireArray(record.options, `${source}.options`).map((entry, index) => parseInteractionOption(entry, `${source}.options[${String(index)}]`));
    }

    return option;
}

function parseDiscordAttachments(value: unknown, source: string): DiscordAttachment[] {
    if (value === undefined) {
        return [];
    }

    return requireArray(value, `${source}.attachments`).map((entry, index) => parseDiscordAttachment(entry, `${source}.attachments[${String(index)}]`));
}

function parseDiscordAttachment(value: unknown, source: string): DiscordAttachment {
    const record = requireRecord(value, source);

    return {
        id: requireString(record.id, `${source}.id`),
        filename: requireString(record.filename, `${source}.filename`),
        contentType: readString(record.content_type, `${source}.content_type`),
        size: requireNumber(record.size, `${source}.size`),
        url: requireString(record.url, `${source}.url`),
        durationSeconds: record.duration_secs === undefined ? null : requireNumber(record.duration_secs, `${source}.duration_secs`),
    };
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`${source} must be an object`);
    }

    return value;
}

function readRecord(value: unknown, source: string): Record<string, unknown> | null {
    if (value === undefined || value === null) {
        return null;
    }

    return requireRecord(value, source);
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

function readString(value: unknown, source: string): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new Error(`${source} must be a string`);
    }

    return value;
}

function readNullableString(value: unknown, source: string): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    return requireString(value, source);
}

function requireNumber(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${source} must be a finite number`);
    }

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
