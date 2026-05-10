import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IntentResolverRunner } from "../src/intent-resolver-runner.js";
import type { OpenCodeMessageResponse, OpenCodeOutputFormat, OpenCodeSession } from "../src/opencode.js";

describe("IntentResolverRunner", () => {
    it("creates a hidden workspace resolver session and parses structured ready output", async () => {
        const opencode = createFakeOpenCode([
            {
                info: {
                    id: "msg_ready",
                    sessionID: "ses_resolver",
                    structuredOutput: {
                        status: "ready",
                        path: "bsociety",
                        prompt: "Continue the existing task.",
                        title: "bsociety",
                        action: "create_session",
                        metadata: {},
                    },
                    error: null,
                },
                parts: [],
            },
        ]);
        const runner = new IntentResolverRunner({ opencode });

        const result = await runner.start({
            text: "work on bsociety",
            workspaceRoot: "/workspace/dev",
        });

        assert.deepEqual(opencode.createdSessions, [
            { title: "Bridge intent resolver", directory: "/workspace/dev" },
        ]);
        assert.equal(opencode.prompts[0]?.sessionID, "ses_resolver");
        assert.equal(opencode.prompts[0]?.directory, "/workspace/dev");
        assert.equal(opencode.prompts[0]?.text.includes("work on bsociety"), true);
        assert.deepEqual(opencode.prompts[0]?.format, {
            type: "json_schema",
            retryCount: 2,
            schema: intentResolverSchemaFixture(),
        });
        assert.deepEqual(result, {
            resolverSessionID: "ses_resolver",
            output: {
                status: "ready",
                path: "/workspace/dev/bsociety",
                prompt: "Continue the existing task.",
                title: "bsociety",
                action: "create_session",
                metadata: {},
            },
        });
    });

    it("continues an existing hidden resolver session with a clarification answer", async () => {
        const opencode = createFakeOpenCode([
            {
                info: {
                    id: "msg_question",
                    sessionID: "ses_resolver",
                    structuredOutput: null,
                    error: null,
                },
                parts: [
                    { type: "text", text: JSON.stringify({
                        status: "needs_clarification",
                        question: "Which repository?",
                        allowFreeText: false,
                        options: [
                            { id: "repo-api", label: "api", value: "api" },
                        ],
                    }) },
                ],
            },
        ]);
        const runner = new IntentResolverRunner({ opencode });

        const result = await runner.continue({
            resolverSessionID: "ses_resolver",
            answer: "api",
            workspaceRoot: "/workspace/dev",
        });

        assert.deepEqual(opencode.createdSessions, []);
        assert.equal(opencode.prompts[0]?.sessionID, "ses_resolver");
        assert.equal(opencode.prompts[0]?.text.includes("api"), true);
        assert.deepEqual(result, {
            resolverSessionID: "ses_resolver",
            output: {
                status: "needs_clarification",
                question: "Which repository?",
                allowFreeText: false,
                options: [
                    { id: "repo-api", label: "api", value: "api" },
                ],
            },
        });
    });

    it("rejects ready output that escapes the configured workspace root", async () => {
        const opencode = createFakeOpenCode([
            {
                info: {
                    id: "msg_ready",
                    sessionID: "ses_resolver",
                    structuredOutput: {
                        status: "ready",
                        path: "/etc",
                        prompt: "Do something unsafe.",
                        title: null,
                        action: "create_session",
                        metadata: {},
                    },
                    error: null,
                },
                parts: [],
            },
        ]);
        const runner = new IntentResolverRunner({ opencode });

        await assert.rejects(
            () => runner.start({ text: "work on etc", workspaceRoot: "/workspace/dev" }),
            /Resolved workspace path must stay under OPENCODE_BRIDGE_WORKSPACE_ROOT/,
        );
    });
});

interface FakePromptInput {
    sessionID: string;
    text: string;
    directory?: string;
    format?: OpenCodeOutputFormat;
}

interface FakeOpenCode {
    createdSessions: Array<{ title?: string; directory?: string }>;
    prompts: FakePromptInput[];
    createSession(input?: { title?: string; directory?: string }): Promise<OpenCodeSession>;
    sendPromptAndWait(input: FakePromptInput): Promise<OpenCodeMessageResponse>;
}

function createFakeOpenCode(responses: OpenCodeMessageResponse[]): FakeOpenCode {
    const fake: FakeOpenCode = {
        createdSessions: [],
        prompts: [],
        async createSession(input = {}) {
            fake.createdSessions.push(input);
            return {
                id: "ses_resolver",
                title: input.title ?? null,
                directory: input.directory ?? null,
                time: null,
            };
        },
        async sendPromptAndWait(input) {
            fake.prompts.push(input);
            const response = responses.shift();
            if (!response) {
                throw new Error("No fake resolver response configured");
            }

            return response;
        },
    };

    return fake;
}

function intentResolverSchemaFixture(): Record<string, unknown> {
    return {
        oneOf: [
            {
                type: "object",
                additionalProperties: false,
                required: ["status", "path", "prompt", "title", "action", "metadata"],
                properties: {
                    status: { const: "ready" },
                    path: { type: "string", minLength: 1 },
                    prompt: { type: "string", minLength: 1 },
                    title: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
                    action: { enum: ["create_session", "attach_session", "clone_repository", "setup_repository"] },
                    metadata: {
                        type: "object",
                        additionalProperties: {
                            anyOf: [
                                { type: "string" },
                                { type: "number" },
                                { type: "boolean" },
                                { type: "null" },
                            ],
                        },
                    },
                },
            },
            {
                type: "object",
                additionalProperties: false,
                required: ["status", "question", "allowFreeText", "options"],
                properties: {
                    status: { const: "needs_clarification" },
                    question: { type: "string", minLength: 1 },
                    allowFreeText: { type: "boolean" },
                    options: {
                        type: "array",
                        maxItems: 10,
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["id", "label"],
                            properties: {
                                id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
                                label: { type: "string", minLength: 1 },
                                value: { type: "string", minLength: 1 },
                            },
                        },
                    },
                },
            },
            {
                type: "object",
                additionalProperties: false,
                required: ["status", "reason"],
                properties: {
                    status: { const: "cannot_resolve" },
                    reason: { type: "string", minLength: 1 },
                },
            },
        ],
    };
}
