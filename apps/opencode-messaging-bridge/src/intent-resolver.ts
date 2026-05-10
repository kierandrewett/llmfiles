import path from "node:path";

export type IntentResolverAction = "create_session" | "attach_session" | "clone_repository" | "setup_repository";
export type IntentResolverMetadataValue = string | number | boolean | null;

export interface IntentResolverReadyOutput {
    status: "ready";
    path: string;
    prompt: string;
    title: string | null;
    action: IntentResolverAction;
    metadata: Record<string, IntentResolverMetadataValue>;
}

export interface IntentResolverClarificationOption {
    id: string;
    label: string;
    value?: string;
}

export interface IntentResolverClarificationOutput {
    status: "needs_clarification";
    question: string;
    allowFreeText: boolean;
    options: IntentResolverClarificationOption[];
}

export interface IntentResolverCannotResolveOutput {
    status: "cannot_resolve";
    reason: string;
}

export type IntentResolverOutput = IntentResolverReadyOutput
    | IntentResolverClarificationOutput
    | IntentResolverCannotResolveOutput;

const INTENT_RESOLVER_ACTIONS = new Set<IntentResolverAction>([
    "create_session",
    "attach_session",
    "clone_repository",
    "setup_repository",
]);
const OPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CLARIFICATION_OPTIONS = 10;

export function parseIntentResolverOutput(raw: string): IntentResolverOutput {
    const record = parseStrictJsonObject(raw);
    const status = requireString(record.status, "Intent resolver output.status");

    if (status === "ready") {
        return parseReadyOutput(record);
    }
    if (status === "needs_clarification") {
        return parseClarificationOutput(record);
    }
    if (status === "cannot_resolve") {
        return {
            status,
            reason: requireString(record.reason, "Intent resolver cannot-resolve output.reason"),
        };
    }

    throw new Error("Intent resolver output.status must be ready, needs_clarification, or cannot_resolve");
}

export function normaliseWorkspacePath(workspaceRoot: string, candidatePath: string): string {
    const root = normaliseAbsolutePath(workspaceRoot, "OPENCODE_BRIDGE_WORKSPACE_ROOT");
    const candidate = candidatePath.trim();
    if (candidate.length === 0) {
        throw new Error("Intent resolver workspace path must be a non-empty string");
    }
    if (candidate.includes("\0")) {
        throw new Error("Intent resolver workspace path must not contain NUL bytes");
    }

    const resolved = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(root, candidate);
    if (!isPathUnderRoot(root, resolved)) {
        throw new Error("Resolved workspace path must stay under OPENCODE_BRIDGE_WORKSPACE_ROOT");
    }

    return resolved;
}

function parseReadyOutput(record: Record<string, unknown>): IntentResolverReadyOutput {
    return {
        status: "ready",
        path: requireString(record.path, "Intent resolver ready output.path"),
        prompt: requireString(record.prompt, "Intent resolver ready output.prompt"),
        title: requireNullableString(record.title, "Intent resolver ready output.title"),
        action: requireAction(record.action, "Intent resolver ready output.action"),
        metadata: parseMetadata(record.metadata, "Intent resolver ready output.metadata"),
    };
}

function parseClarificationOutput(record: Record<string, unknown>): IntentResolverClarificationOutput {
    const allowFreeText = requireBoolean(record.allowFreeText, "Intent resolver clarification output.allowFreeText");
    const options = requireArray(record.options, "Intent resolver clarification output.options")
        .map((entry, index) => parseClarificationOption(entry, `Intent resolver clarification output.options[${String(index)}]`));
    if (!allowFreeText && options.length === 0) {
        throw new Error("Intent resolver clarification output.options must include at least one option when free text is disabled");
    }
    if (options.length > MAX_CLARIFICATION_OPTIONS) {
        throw new Error(`Intent resolver clarification output.options must include at most ${String(MAX_CLARIFICATION_OPTIONS)} options`);
    }

    return {
        status: "needs_clarification",
        question: requireString(record.question, "Intent resolver clarification output.question"),
        allowFreeText,
        options,
    };
}

function parseClarificationOption(value: unknown, source: string): IntentResolverClarificationOption {
    const record = requireRecord(value, source);
    const id = requireString(record.id, `${source}.id`);
    if (!OPTION_ID_PATTERN.test(id)) {
        throw new Error(`${source}.id must be 1-64 ASCII letters, numbers, dashes, or underscores`);
    }

    const option: IntentResolverClarificationOption = {
        id,
        label: requireString(record.label, `${source}.label`),
    };
    const valueField = readOptionalString(record.value, `${source}.value`);
    if (valueField !== undefined) {
        option.value = valueField;
    }

    return option;
}

function parseMetadata(value: unknown, source: string): Record<string, IntentResolverMetadataValue> {
    const record = requireRecord(value, source);
    const metadata: Record<string, IntentResolverMetadataValue> = {};
    for (const [key, entry] of Object.entries(record)) {
        if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
            metadata[key] = entry;
            continue;
        }
        if (typeof entry === "number" && Number.isFinite(entry)) {
            metadata[key] = entry;
            continue;
        }

        throw new Error(`${source}.${key} must be a string, number, boolean, or null`);
    }

    return metadata;
}

function parseStrictJsonObject(raw: string): Record<string, unknown> {
    try {
        return requireRecord(JSON.parse(raw.trim()) as unknown, "Intent resolver output");
    } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`Intent resolver output must be strict JSON${reason}`);
    }
}

function normaliseAbsolutePath(value: string, source: string): string {
    const trimmed = value.trim();
    if (!path.isAbsolute(trimmed)) {
        throw new Error(`${source} must be an absolute path`);
    }

    return path.resolve(trimmed);
}

function isPathUnderRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${source} must be a non-empty string`);
    }

    return value.trim();
}

function requireNullableString(value: unknown, source: string): string | null {
    if (value === null) {
        return null;
    }

    return requireString(value, source);
}

function readOptionalString(value: unknown, source: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    return requireString(value, source);
}

function requireBoolean(value: unknown, source: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${source} must be a boolean`);
    }

    return value;
}

function requireAction(value: unknown, source: string): IntentResolverAction {
    const action = requireString(value, source);
    if (!INTENT_RESOLVER_ACTIONS.has(action as IntentResolverAction)) {
        throw new Error(`${source} must be create_session, attach_session, clone_repository, or setup_repository`);
    }

    return action as IntentResolverAction;
}
