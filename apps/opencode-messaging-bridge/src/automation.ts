import {
    type BridgeScheduledJobState,
    type BridgeState,
    loadOrCreateBridgeState,
    writeBridgeState,
} from "./state.js";

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const ERROR_SUMMARY_LIMIT = 500;

export interface ScheduledPromptOpenCodeClient {
    sendPrompt(input: { sessionID: string; text: string }): Promise<void>;
}

export interface ScheduledPromptRunnerDependencies {
    statePath: string;
    opencode: ScheduledPromptOpenCodeClient;
    now?: () => Date;
}

export type ScheduleParseResult =
    | { ok: true; intervalMinutes: number; prompt: string }
    | { ok: false; message: string };

export class ScheduledPromptRunner {
    private readonly statePath: string;
    private readonly opencode: ScheduledPromptOpenCodeClient;
    private readonly now: () => Date;

    constructor(dependencies: ScheduledPromptRunnerDependencies) {
        this.statePath = dependencies.statePath;
        this.opencode = dependencies.opencode;
        this.now = dependencies.now ?? (() => new Date());
    }

    async runDueJobs(): Promise<number> {
        const state = await loadOrCreateBridgeState(this.statePath, this.now());
        const now = this.now();
        const dueJobs = state.jobs.filter((job) => isDue(job, now));
        if (dueJobs.length === 0) {
            return 0;
        }

        for (const job of dueJobs) {
            await this.runJob(state, job, now);
        }

        state.updatedAt = now.toISOString();
        await writeBridgeState(this.statePath, state);
        return dueJobs.length;
    }

    private async runJob(state: BridgeState, job: BridgeScheduledJobState, now: Date): Promise<void> {
        const storedJob = state.jobs.find((entry) => entry.id === job.id);
        if (!storedJob) {
            return;
        }

        try {
            await this.opencode.sendPrompt({ sessionID: storedJob.sessionID, text: storedJob.prompt });
            recordScheduledJobRun(storedJob, now, null);
        } catch (error) {
            recordScheduledJobRun(storedJob, now, scheduleErrorMessage(error));
        }
    }
}

export function parseScheduleArgs(args: string[]): ScheduleParseResult {
    if (args[0]?.toLowerCase() !== "every") {
        return { ok: false, message: "schedule syntax is every <duration> <prompt>" };
    }

    const duration = parseDurationMinutes(args[1] ?? "");
    if (duration === null) {
        return { ok: false, message: "duration must be between 5m and 7d" };
    }

    const prompt = args.slice(2).join(" ").trim();
    if (!prompt) {
        return { ok: false, message: "prompt text is required" };
    }

    return { ok: true, intervalMinutes: duration, prompt };
}

export function nextScheduledRun(now: Date, intervalMinutes: number): string {
    return addMinutes(now, intervalMinutes).toISOString();
}

export function formatScheduleInterval(intervalMinutes: number): string {
    if (intervalMinutes % (24 * 60) === 0) {
        return `${String(intervalMinutes / (24 * 60))}d`;
    }
    if (intervalMinutes % 60 === 0) {
        return `${String(intervalMinutes / 60)}h`;
    }

    return `${String(intervalMinutes)}m`;
}

export function createScheduledJobID(state: BridgeState, now: Date): string {
    const stamp = now.toISOString().replace(/[-:.]/g, "");
    let counter = 1;
    for (;;) {
        const id = `job_${stamp}_${String(counter)}`;
        if (!state.jobs.some((job) => job.id === id)) {
            return id;
        }

        counter += 1;
    }
}

export function recordScheduledJobRun(job: BridgeScheduledJobState, now: Date, error: string | null): void {
    const timestamp = now.toISOString();
    job.lastRunAt = timestamp;
    job.lastError = error;
    job.nextRunAt = nextScheduledRun(now, job.intervalMinutes);
    job.updatedAt = timestamp;
}

export function scheduleErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.length <= ERROR_SUMMARY_LIMIT) {
        return message;
    }

    return `${message.slice(0, ERROR_SUMMARY_LIMIT - 3)}...`;
}

function isDue(job: BridgeScheduledJobState, now: Date): boolean {
    const time = Date.parse(job.nextRunAt);
    return Number.isFinite(time) && time <= now.getTime();
}

function parseDurationMinutes(value: string): number | null {
    const match = /^(\d+)([mhd]?)$/i.exec(value.trim());
    if (!match) {
        return null;
    }

    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase() || "m";
    const minutes = unit === "d"
        ? amount * 24 * 60
        : unit === "h"
            ? amount * 60
            : amount;
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        return null;
    }

    return minutes;
}

function addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
}
