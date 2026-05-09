import type { OpenCodeEvent } from "./opencode.js";

export type OpenCodeToolUpdateStatus = "running" | "completed" | "error";

export interface OpenCodeToolUpdate {
    key: string;
    sessionID: string;
    tool: string;
    status: OpenCodeToolUpdateStatus;
    title: string;
}

export interface OpenCodeSessionError {
    sessionID: string;
    message: string;
}

const TOOL_STATUSES = new Set<OpenCodeToolUpdateStatus>(["running", "completed", "error"]);
const SUMMARY_LIMIT = 500;

export function toolUpdateFromEvent(event: OpenCodeEvent): OpenCodeToolUpdate | null {
    if (event.type !== "message.part.updated") {
        return null;
    }

    const part = readRecord(event.properties.part);
    if (!part || part.type !== "tool") {
        return null;
    }

    const state = readRecord(part.state);
    const status = readToolStatus(state?.status);
    if (!state || !status) {
        return null;
    }

    const sessionID = readString(part.sessionID) ?? readString(part.sessionId);
    const partID = readString(part.id) ?? readString(part.callID);
    const tool = readString(part.tool) ?? "tool";
    if (!sessionID || !partID) {
        return null;
    }

    return {
        key: `${sessionID}:${partID}:${status}`,
        sessionID,
        tool,
        status,
        title: toolUpdateTitle(status, state),
    };
}

export function sessionErrorFromEvent(event: OpenCodeEvent): OpenCodeSessionError | null {
    if (event.type !== "session.error") {
        return null;
    }

    const sessionID = readString(event.properties.sessionID) ?? readString(event.properties.sessionId);
    if (!sessionID) {
        return null;
    }

    return {
        sessionID,
        message: errorMessage(event.properties.error),
    };
}

function readToolStatus(value: unknown): OpenCodeToolUpdateStatus | null {
    return typeof value === "string" && TOOL_STATUSES.has(value as OpenCodeToolUpdateStatus)
        ? value as OpenCodeToolUpdateStatus
        : null;
}

function toolUpdateTitle(status: OpenCodeToolUpdateStatus, state: Record<string, unknown>): string {
    if (status === "error") {
        return truncateSummary(readString(state.error) ?? readString(state.title) ?? "tool failed");
    }

    return truncateSummary(readString(state.title) ?? status);
}

function errorMessage(value: unknown): string {
    if (typeof value === "string" && value.length > 0) {
        return truncateSummary(value);
    }

    const record = readRecord(value);
    if (!record) {
        return "unknown error";
    }

    const name = readString(record.name);
    const data = readRecord(record.data);
    const message = readString(data?.message) ?? readString(record.message);
    if (name && message) {
        return truncateSummary(`${name}: ${message}`);
    }
    if (message) {
        return truncateSummary(message);
    }
    if (name) {
        return truncateSummary(name);
    }

    return "unknown error";
}

function truncateSummary(value: string): string {
    if (value.length <= SUMMARY_LIMIT) {
        return value;
    }

    return `${value.slice(0, SUMMARY_LIMIT - 3)}...`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}
