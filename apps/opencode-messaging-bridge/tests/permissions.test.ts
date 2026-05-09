import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OpenCodeEvent } from "../src/opencode.js";
import { permissionRequestFromEvent } from "../src/permissions.js";

describe("permissionRequestFromEvent", () => {
    it("normalises the current OpenCode permission asked event shape", () => {
        const permission = permissionRequestFromEvent({
            type: "permission.asked",
            properties: {
                id: "per_123",
                sessionID: "ses_abc",
                permission: "bash",
                patterns: ["git status"],
                always: ["git status*"],
                metadata: { command: "git status" },
                tool: { messageID: "msg_123", callID: "call_123" },
            },
        });

        assert.deepEqual(permission, {
            id: "per_123",
            sessionID: "ses_abc",
            permission: "bash",
            title: "bash: git status",
            patterns: ["git status"],
            always: ["git status*"],
            callID: "call_123",
            messageID: "msg_123",
            metadata: { command: "git status" },
        });
    });

    it("normalises the generated SDK permission updated event shape", () => {
        const permission = permissionRequestFromEvent({
            type: "permission.updated",
            properties: {
                id: "per_456",
                sessionID: "ses_abc",
                type: "edit",
                pattern: ["src/a.ts", "src/b.ts"],
                title: "Edit files",
                metadata: {},
                messageID: "msg_456",
                callID: "call_456",
                time: { created: 1 },
            },
        });

        assert.deepEqual(permission, {
            id: "per_456",
            sessionID: "ses_abc",
            permission: "edit",
            title: "Edit files",
            patterns: ["src/a.ts", "src/b.ts"],
            always: [],
            callID: "call_456",
            messageID: "msg_456",
            metadata: {},
        });
    });

    it("ignores unrelated or incomplete events", () => {
        assert.equal(permissionRequestFromEvent({ type: "session.idle", properties: { sessionID: "ses_abc" } }), null);
        assert.equal(permissionRequestFromEvent({ type: "permission.asked", properties: { id: "per_123" } } as OpenCodeEvent), null);
    });
});
