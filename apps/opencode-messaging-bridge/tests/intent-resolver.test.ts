import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    normaliseWorkspacePath,
    parseIntentResolverOutput,
} from "../src/intent-resolver.js";

describe("parseIntentResolverOutput", () => {
    it("parses ready resolver output with declared action metadata", () => {
        const output = parseIntentResolverOutput(JSON.stringify({
            status: "ready",
            path: "bsociety",
            prompt: "Continue the project plan.",
            title: "bsociety planning",
            action: "create_session",
            metadata: {
                repo: "bsociety",
                fresh: false,
                matches: 1,
                note: null,
            },
        }));

        assert.deepEqual(output, {
            status: "ready",
            path: "bsociety",
            prompt: "Continue the project plan.",
            title: "bsociety planning",
            action: "create_session",
            metadata: {
                repo: "bsociety",
                fresh: false,
                matches: 1,
                note: null,
            },
        });
    });

    it("parses clarification output with button-safe option IDs", () => {
        const output = parseIntentResolverOutput(JSON.stringify({
            status: "needs_clarification",
            question: "Which repository do you mean?",
            allowFreeText: true,
            options: [
                { id: "repo-bsociety", label: "bsociety", value: "bsociety" },
                { id: "repo-bsociety-web", label: "bsociety-web", value: "bsociety-web" },
            ],
        }));

        assert.deepEqual(output, {
            status: "needs_clarification",
            question: "Which repository do you mean?",
            allowFreeText: true,
            options: [
                { id: "repo-bsociety", label: "bsociety", value: "bsociety" },
                { id: "repo-bsociety-web", label: "bsociety-web", value: "bsociety-web" },
            ],
        });
    });

    it("parses terminal cannot-resolve output", () => {
        const output = parseIntentResolverOutput(JSON.stringify({
            status: "cannot_resolve",
            reason: "No matching workspace was found.",
        }));

        assert.deepEqual(output, {
            status: "cannot_resolve",
            reason: "No matching workspace was found.",
        });
    });

    it("rejects non-JSON or structurally invalid resolver output", () => {
        assert.throws(
            () => parseIntentResolverOutput("```json\n{\"status\":\"cannot_resolve\",\"reason\":\"no\"}\n```"),
            /Intent resolver output must be strict JSON/,
        );
        assert.throws(
            () => parseIntentResolverOutput(JSON.stringify({ status: "ready", path: "bsociety" })),
            /Intent resolver ready output.prompt must be a non-empty string/,
        );
        assert.throws(
            () => parseIntentResolverOutput(JSON.stringify({
                status: "needs_clarification",
                question: "Which repo?",
                allowFreeText: false,
                options: [],
            })),
            /Intent resolver clarification output.options must include at least one option when free text is disabled/,
        );
    });
});

describe("normaliseWorkspacePath", () => {
    it("resolves relative and absolute paths under the configured workspace root", () => {
        assert.equal(normaliseWorkspacePath("/workspace/dev", "bsociety"), "/workspace/dev/bsociety");
        assert.equal(normaliseWorkspacePath("/workspace/dev", "/workspace/dev/bsociety"), "/workspace/dev/bsociety");
        assert.equal(normaliseWorkspacePath("/workspace/dev", "."), "/workspace/dev");
    });

    it("rejects paths outside the configured workspace root", () => {
        assert.throws(
            () => normaliseWorkspacePath("/workspace/dev", "../secrets"),
            /Resolved workspace path must stay under OPENCODE_BRIDGE_WORKSPACE_ROOT/,
        );
        assert.throws(
            () => normaliseWorkspacePath("/workspace/dev", "/etc/passwd"),
            /Resolved workspace path must stay under OPENCODE_BRIDGE_WORKSPACE_ROOT/,
        );
    });
});
