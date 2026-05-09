import type { OpenCodeEvent } from "./opencode.js";

export interface OpenCodeEventSource {
    subscribeEvents(): Promise<AsyncIterable<OpenCodeEvent>>;
}

export interface OpenCodeEventHandler {
    handleEvent(event: OpenCodeEvent): Promise<void>;
}

export interface OpenCodeEventPumpDependencies {
    source: OpenCodeEventSource;
    handler: OpenCodeEventHandler;
}

export class OpenCodeEventPump {
    private readonly source: OpenCodeEventSource;
    private readonly handler: OpenCodeEventHandler;

    constructor(dependencies: OpenCodeEventPumpDependencies) {
        this.source = dependencies.source;
        this.handler = dependencies.handler;
    }

    async runOnce(): Promise<number> {
        const events = await this.source.subscribeEvents();
        let processed = 0;

        for await (const event of events) {
            await this.handler.handleEvent(event);
            processed += 1;
        }

        return processed;
    }
}
