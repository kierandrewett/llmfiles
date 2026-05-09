import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionErrorFromEvent, toolUpdateFromEvent } from "../src/event-summaries.js";

describe("toolUpdateFromEvent", () => {
    it("normalises running, completed, and error tool states", () => {
        assert.deepEqual(toolUpdateFromEvent(toolEvent("running", { title: "git status" })), {
            key: "ses_abc:tool_1:running",
            sessionID: "ses_abc",
            tool: "bash",
            status: "running",
            title: "git status",
        });
        assert.deepEqual(toolUpdateFromEvent(toolEvent("completed", { title: "git status" })), {
            key: "ses_abc:tool_1:completed",
            sessionID: "ses_abc",
            tool: "bash",
            status: "completed",
            title: "git status",
        });
        assert.deepEqual(toolUpdateFromEvent(toolEvent("error", { error: "command failed" })), {
            key: "ses_abc:tool_1:error",
            sessionID: "ses_abc",
            tool: "bash",
            status: "error",
            title: "command failed",
        });
    });

    it("ignores pending and unrelated events", () => {
        assert.equal(toolUpdateFromEvent(toolEvent("pending", {})), null);
        assert.equal(toolUpdateFromEvent({ type: "session.idle", properties: { sessionID: "ses_abc" } }), null);
    });
});

describe("sessionErrorFromEvent", () => {
    it("normalises session errors with names and messages", () => {
        assert.deepEqual(sessionErrorFromEvent({
            type: "session.error",
            properties: {
                sessionID: "ses_abc",
                error: { name: "ProviderAuthError", data: { message: "missing API key" } },
            },
        }), {
            sessionID: "ses_abc",
            message: "ProviderAuthError: missing API key",
        });
    });
});

function toolEvent(status: string, state: Record<string, unknown>) {
    return {
        type: "message.part.updated",
        properties: {
            part: {
                id: "tool_1",
                sessionID: "ses_abc",
                messageID: "msg_1",
                type: "tool",
                callID: "call_1",
                tool: "bash",
                state: {
                    status,
                    input: {},
                    ...state,
                },
            },
        },
    };
}
