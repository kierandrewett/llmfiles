import type { OpenCodeEvent } from "./opencode.js";

export interface OpenCodePermissionRequest {
    id: string;
    sessionID: string;
    permission: string;
    title: string;
    patterns: string[];
    always: string[];
    callID: string | null;
    messageID: string | null;
    metadata: Record<string, unknown>;
}

const PERMISSION_REQUEST_EVENTS = new Set(["permission.updated", "permission.asked"]);

export function permissionRequestFromEvent(event: OpenCodeEvent): OpenCodePermissionRequest | null {
    if (!PERMISSION_REQUEST_EVENTS.has(event.type)) {
        return null;
    }

    const properties = event.properties;
    const tool = readRecord(properties.tool);
    const id = readString(properties.id);
    const sessionID = readString(properties.sessionID) ?? readString(properties.sessionId);
    if (!id || !sessionID) {
        return null;
    }

    const permission = readString(properties.permission) ?? readString(properties.type) ?? "permission";
    const patterns = readStringList(properties.patterns) ?? readStringList(properties.pattern) ?? [];
    const always = readStringList(properties.always) ?? [];
    const title = readString(properties.title) ?? defaultPermissionTitle(permission, patterns);

    return {
        id,
        sessionID,
        permission,
        title,
        patterns,
        always,
        callID: readString(properties.callID) ?? readString(tool?.callID),
        messageID: readString(properties.messageID) ?? readString(tool?.messageID),
        metadata: readRecord(properties.metadata) ?? {},
    };
}

function defaultPermissionTitle(permission: string, patterns: string[]): string {
    const [firstPattern] = patterns;
    if (firstPattern) {
        return `${permission}: ${firstPattern}`;
    }

    return permission;
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

function readStringList(value: unknown): string[] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === "string") {
        return value.length > 0 ? [value] : [];
    }
    if (!Array.isArray(value)) {
        return null;
    }

    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
