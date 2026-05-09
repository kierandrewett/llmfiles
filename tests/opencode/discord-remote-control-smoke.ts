import { DiscordRemoteControl } from "../../plugins/opencode/discord-remote-control.ts";

type JsonObject = Record<string, unknown>;

type Listener = (event: { data?: string; code?: number; reason?: string }) => void;

type ToolHookInput = {
    tool: string;
    sessionID: string;
    callID: string;
    args?: unknown;
};

type PluginHooks = {
    event?: (input: { event: unknown }) => Promise<void>;
    "tool.execute.before"?: (input: ToolHookInput, output?: unknown) => Promise<void>;
    "tool.execute.after"?: (input: ToolHookInput, output: unknown) => Promise<void>;
};

type CapturedRequest = {
    method: string;
    url: string;
    body: unknown;
};

const requests: CapturedRequest[] = [];
const gatewaySends: unknown[] = [];
const prompts: unknown[] = [];
const syncPrompts: unknown[] = [];
const createdSessions: unknown[] = [];
const deletedSessions: unknown[] = [];
const logs: unknown[] = [];
const availableTags: Array<{ id: string; name: string }> = [{ id: "tag-existing-model", name: "openai/gpt-5.5" }];
const appliedTags = new Map<string, string[]>();

let tagCounter = 1;

function objectValue(value: unknown): JsonObject {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown, fallback = ""): string {
    return typeof value === "string" && value.trim() ? value : fallback;
}

function sessionTitle(input: unknown): string {
    const object = objectValue(input);
    return String(object.title || objectValue(object.body).title || "untitled");
}

function sessionDirectory(input: unknown): string {
    const object = objectValue(input);
    return String(object.directory || objectValue(object.query).directory || "/tmp/opencode");
}

function sessionID(input: unknown): string {
    const object = objectValue(input);
    return String(object.sessionID || objectValue(object.path).sessionID || objectValue(object.path).id || "unknown");
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function response(body: unknown, status = 200): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function parseBody(body: BodyInit | null | undefined): unknown {
    if (typeof body !== "string") return null;
    return JSON.parse(body) as unknown;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

class FakeWebSocket {
    static OPEN = 1;
    static instance: FakeWebSocket | null = null;

    readyState = FakeWebSocket.OPEN;
    listeners = new Map<string, Listener[]>();

    constructor(public url: string) {
        FakeWebSocket.instance = this;
    }

    addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    send(data: string): void {
        gatewaySends.push(JSON.parse(data) as unknown);
    }

    close(code = 1000, reason = "closed"): void {
        this.readyState = 3;
        this.emit("close", { code, reason });
    }

    emit(type: string, event: { data?: string; code?: number; reason?: string }): void {
        for (const listener of this.listeners.get(type) || []) listener(event);
    }
}

const fakeFetch: typeof fetch = async (url, init) => {
    const method = init?.method || "GET";
    const body = parseBody(init?.body);
    const href = String(url);
    requests.push({ method, url: href, body });

    if (href.endsWith("/gateway/bot")) return response({ url: "ws://discord.test/gateway" });
    if (href.includes("/applications/app-1/guilds/guild-1/commands")) return response({ id: "command-1" });
    if (href.includes("/interactions/int-1/token-1/callback")) return response(null, 204);

    if (href.endsWith("/channels/channel-1") && method === "GET") return response({ id: "channel-1", type: 15, available_tags: availableTags });
    if (href.endsWith("/channels/channel-1") && method === "PATCH") {
        const nextTags = Array.isArray(objectValue(body).available_tags) ? objectValue(body).available_tags as Array<{ id?: string; name: string }> : availableTags;
        availableTags.splice(0, availableTags.length, ...nextTags.map((tag) => ({ id: tag.id || `tag-created-${tagCounter++}`, name: tag.name })));
        return response({ id: "channel-1", type: 15, available_tags: availableTags });
    }

    if (href.includes("/channels/channel-1/threads")) {
        if (!objectValue(body).message) {
            return response(
                {
                    message: "Invalid Form Body",
                    code: 50035,
                    errors: { message: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] } },
                },
                400,
            );
        }
        const bodyObject = objectValue(body);
        appliedTags.set("thread-1", Array.isArray(bodyObject.applied_tags) ? bodyObject.applied_tags.map(String) : []);
        return response({ id: "thread-1" });
    }

    if (href.includes("/reactions/")) return response(null, 204);
    if (href.includes("/channels/thread-1/messages")) return response({ id: "message-thread" });
    if (href.endsWith("/channels/thread-1") && method === "GET") return response({ id: "thread-1", applied_tags: appliedTags.get("thread-1") || [] });
    if (href.includes("/channels/thread-1") && method === "PATCH") return response({ id: "thread-1" });

    if (href.includes("/channels/forum-thread-1/messages")) return response({ id: "message-forum" });
    if (href.endsWith("/channels/forum-thread-1") && method === "GET") return response({ id: "forum-thread-1", applied_tags: appliedTags.get("forum-thread-1") || [] });
    if (href.includes("/channels/forum-thread-1") && method === "PATCH") {
        const bodyObject = objectValue(body);
        if (Array.isArray(bodyObject.applied_tags)) appliedTags.set("forum-thread-1", bodyObject.applied_tags.map(String));
        return response({ id: "forum-thread-1", name: bodyObject.name || "Fix Atlas dashboard", applied_tags: appliedTags.get("forum-thread-1") || [] });
    }

    if (href.includes("/channels/channel-1/messages")) return response({ id: "message-control" });

    throw new Error(`unexpected fetch ${method} ${href}`);
};

function emitGateway(payload: unknown): void {
    FakeWebSocket.instance?.emit("message", { data: JSON.stringify(payload) });
}

async function main(): Promise<void> {
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    globalThis.fetch = fakeFetch;

    const hooks = await DiscordRemoteControl(
        {
            client: {
                app: { log: async (input: { body: unknown }) => logs.push(input.body) },
                tui: { showToast: async () => undefined },
                vcs: {
                    get: async (input: unknown) => ({
                        data: { branch: sessionDirectory(input).includes("lifeos-scrubbed") ? "master" : "main" },
                    }),
                },
                session: {
                    create: async (input: unknown) => {
                        createdSessions.push(input);
                        const title = sessionTitle(input);
                        const targetDirectory = sessionDirectory(input);
                        if (title === "Discord forum intake classifier") return { data: { id: "classifier-1", title, directory: targetDirectory } };
                        if (title === "Fix Atlas dashboard") return { data: { id: "forum-session-1", title, directory: targetDirectory } };
                        return { data: { id: "session-1", title, directory: targetDirectory } };
                    },
                    delete: async (input: unknown) => {
                        deletedSessions.push(input);
                        return { data: true };
                    },
                    get: async (input: unknown) => {
                        const id = sessionID(input);
                        if (id === "forum-session-1") return { data: { id, title: "Fix Atlas dashboard", directory: "/home/kieran/dev/lifeos-scrubbed" } };
                        return { data: { id, title: "Discord Remote Control", directory: "/tmp/opencode" } };
                    },
                    prompt: async (input: unknown) => {
                        syncPrompts.push(input);
                        return {
                            data: {
                                info: {
                                    structured: {
                                        title: "Fix Atlas dashboard",
                                        directory: "/home/kieran/dev/lifeos-scrubbed",
                                        providerID: "openai",
                                        modelID: "gpt-5.5",
                                        variant: "high",
                                        prompt: "Fix the Atlas dashboard smoke failure.",
                                    },
                                },
                            },
                        };
                    },
                    promptAsync: async (input: unknown) => prompts.push(input),
                    status: async () => ({ data: { ok: true } }),
                    list: async () => ({ data: [{ id: "session-1", title: "Discord Remote Control", directory: "/tmp/opencode" }] }),
                },
            },
            directory: "/tmp/opencode",
        },
        {
            token: "token-1",
            applicationID: "app-1",
            channelID: "channel-1",
            guildID: "guild-1",
            allowedUserIDs: "user-1",
            threadsEnabled: true,
            forumPostsEnabled: true,
            includeToolOutput: false,
            statePath: `/tmp/opencode/discord-plugin-smoke-${Date.now()}.json`,
            sendDelayMs: 5,
            streamFlushMs: 20,
            presenceUpdateMs: 600000,
        },
    ) as PluginHooks;

    assert(hooks.event, "plugin did not expose an event hook");

    await wait(20);
    emitGateway({ op: 10, d: { heartbeat_interval: 120000 }, s: null, t: null });
    emitGateway({
        op: 0,
        t: "READY",
        s: 1,
        d: {
            user: { id: "bot-1" },
            application: { id: "app-1" },
            session_id: "gateway-session-1",
            resume_gateway_url: "ws://discord.test/resume",
        },
    });
    await wait(50);

    emitGateway({
        op: 0,
        t: "INTERACTION_CREATE",
        s: 2,
        d: {
            id: "int-1",
            token: "token-1",
            type: 2,
            channel_id: "channel-1",
            guild_id: "guild-1",
            member: { user: { id: "user-1" } },
            data: {
                name: "oc",
                type: 1,
                options: [{ name: "prompt", type: 1, options: [{ name: "text", type: 3, value: "hello from slash" }] }],
            },
        },
    });
    await wait(100);

    await hooks.event({
        event: {
            type: "message.part.delta",
            properties: { sessionID: "session-1", partID: "part-1", field: "text", delta: "assistant reply\n<system-reminder>internal noise</system-reminder>" },
        },
    });
    await hooks.event({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    id: "part-1",
                    sessionID: "session-1",
                    type: "text",
                    text: "assistant reply\n<system-reminder>internal noise</system-reminder>",
                },
            },
        },
    });
    await wait(250);

    emitGateway({
        op: 0,
        t: "THREAD_CREATE",
        s: 3,
        d: {
            id: "forum-thread-1",
            type: 11,
            parent_id: "channel-1",
            owner_id: "user-1",
            name: "Fix Atlas dashboard",
        },
    });
    emitGateway({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 4,
        d: {
            id: "forum-message-1",
            channel_id: "forum-thread-1",
            guild_id: "guild-1",
            author: { id: "user-1" },
            content: "Use the lifeos scrubbed folder with openai/gpt-5.5 high and fix the Atlas dashboard smoke failure.",
        },
    });
    await wait(500);

    await hooks["tool.execute.after"]?.({ tool: "read", sessionID: "forum-session-1", callID: "read-1", args: { filePath: "/tmp/file.ts" } }, { title: "Read file", output: "file contents", metadata: {} });
    await hooks.event({
        event: {
            type: "message.part.updated",
            properties: { part: { id: "thinking-1", sessionID: "forum-session-1", type: "reasoning", text: "Running tests\nNeed bash first" } },
        },
    });
    await hooks["tool.execute.after"]?.(
        { tool: "bash", sessionID: "forum-session-1", callID: "bash-1", args: { description: "Runs tests", command: "yarn test", workdir: "/tmp/opencode" } },
        { title: "Tests passed", output: "", metadata: { exitCode: 0 } },
    );
    await hooks["tool.execute.after"]?.(
        { tool: "grep", sessionID: "forum-session-1", callID: "grep-1", args: { pattern: "TODO", path: "/tmp/opencode" } },
        { title: "grep failed", output: "missing path", metadata: { exitCode: 2 } },
    );
    await wait(250);

    const messageBodies = requests
        .filter((request) => request.url.includes("/messages") && !request.url.includes("/reactions/"))
        .map((request) => JSON.stringify(request.body));
    const allBodies = messageBodies.join("\n");
    const forumPrompt = prompts.find((entry) => sessionID(entry) === "forum-session-1");
    const classifierPrompt = JSON.stringify(syncPrompts);

    assert(requests.some((request) => request.url.includes("/applications/app-1/guilds/guild-1/commands")), "slash command was not registered");
    assert(requests.some((request) => request.url.includes("/interactions/int-1/token-1/callback")), "slash interaction was not acknowledged");
    assert(requests.some((request) => request.url.includes("/channels/channel-1/threads") && JSON.stringify(request.body).includes("Starting opencode session")), "forum starter message was not used for session thread creation");
    assert(createdSessions.some((entry) => sessionTitle(entry) === "Discord forum intake classifier"), "forum classifier session was not created");
    assert(deletedSessions.some((entry) => sessionID(entry) === "classifier-1"), "forum classifier session was not deleted");
    assert(classifierPrompt.includes('"read":true') && classifierPrompt.includes('"bash":false'), "forum classifier tool restrictions were not applied");
    assert(createdSessions.some((entry) => sessionTitle(entry) === "Fix Atlas dashboard"), "forum post did not create the real session");
    assert(sessionDirectory(forumPrompt).includes("lifeos-scrubbed"), "forum prompt did not use the classifier directory");
    assert(JSON.stringify(forumPrompt).includes('"providerID":"openai"') && JSON.stringify(forumPrompt).includes('"variant":"high"'), "forum prompt did not preserve classifier model metadata");
    assert(availableTags.some((tag) => tag.name === "openai/gpt-5.5 high"), "forum model/variant tag was not created");
    assert(requests.some((request) => request.url.includes("/channels/forum-thread-1") && request.method === "PATCH" && JSON.stringify(request.body).includes("Fix Atlas dashboard")), "forum thread was not renamed from metadata");
    assert(allBodies.includes('"content":"assistant reply"'), "assistant text was not relayed as plain content");
    assert(!allBodies.includes("system-reminder") && !allBodies.includes("internal noise"), "system reminder text leaked into Discord output");
    assert(!allBodies.includes("Read file"), "successful read tool output was not suppressed");
    assert(allBodies.includes("-> bash: Tests passed"), "important successful tool output was not reported");
    assert(allBodies.includes("-> grep failed: grep failed") && allBodies.includes("missing path"), "failed tool output was not reported");
    assert(requests.every((request) => !request.url.includes("/messages") || request.url.includes("/reactions/") || JSON.stringify(request.body).includes('"allowed_mentions":{"parse":[]}')), "message send missed allowed_mentions suppression");
    assert(!logs.some((entry) => JSON.stringify(entry).includes('"level":"error"')), "plugin logged errors during smoke test");
    assert(gatewaySends.some((entry) => JSON.stringify(entry).includes("token-1")), "gateway identify was not sent");

    console.log("discord remote-control plugin smoke passed");
}

main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
    });
