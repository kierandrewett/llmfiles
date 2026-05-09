import { loadOrCreateBridgeState, readBridgeState, writeBridgeState } from "./state.js";
import type { GetUpdatesOptions, TelegramUpdate } from "./telegram.js";

const DEFAULT_TIMEOUT_SECONDS = 30;

export interface TelegramPollerClient {
    getUpdates(options?: GetUpdatesOptions): Promise<TelegramUpdate[]>;
}

export interface TelegramPollerRouter {
    handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface TelegramBridgePollerDependencies {
    statePath: string;
    telegram: TelegramPollerClient;
    router: TelegramPollerRouter;
    now?: () => Date;
    timeoutSeconds?: number;
}

export class TelegramBridgePoller {
    private readonly statePath: string;
    private readonly telegram: TelegramPollerClient;
    private readonly router: TelegramPollerRouter;
    private readonly now: () => Date;
    private readonly timeoutSeconds: number;

    constructor(dependencies: TelegramBridgePollerDependencies) {
        this.statePath = dependencies.statePath;
        this.telegram = dependencies.telegram;
        this.router = dependencies.router;
        this.now = dependencies.now ?? (() => new Date());
        this.timeoutSeconds = dependencies.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    }

    async runOnce(): Promise<number> {
        const state = await loadOrCreateBridgeState(this.statePath, this.now());
        const request: GetUpdatesOptions = {
            timeoutSeconds: this.timeoutSeconds,
            allowedUpdates: ["message"],
        };

        if (state.platforms.telegram.updateOffset !== null) {
            request.offset = state.platforms.telegram.updateOffset;
        }

        const updates = await this.telegram.getUpdates(request);
        for (const update of updates) {
            await this.router.handleUpdate(update);
            await this.advanceOffset(update.updateID + 1);
        }

        return updates.length;
    }

    private async advanceOffset(offset: number): Promise<void> {
        const state = await readBridgeState(this.statePath);
        state.platforms.telegram.updateOffset = offset;
        state.updatedAt = this.now().toISOString();
        await writeBridgeState(this.statePath, state);
    }
}
