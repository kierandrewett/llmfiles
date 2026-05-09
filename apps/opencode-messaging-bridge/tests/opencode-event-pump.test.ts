import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenCodeEventPump } from "../src/opencode-event-pump.js";
import type { OpenCodeEvent } from "../src/opencode.js";

describe("OpenCodeEventPump", () => {
    it("subscribes to OpenCode events and passes each event to the handler", async () => {
        const events = [
            { type: "server.connected", properties: {} },
            { type: "session.idle", properties: { sessionID: "ses_abc" } },
        ];
        const handled: OpenCodeEvent[] = [];
        const pump = new OpenCodeEventPump({
            source: {
                async subscribeEvents(): Promise<AsyncIterable<OpenCodeEvent>> {
                    return eventStream(events);
                },
            },
            handler: {
                async handleEvent(event: OpenCodeEvent): Promise<void> {
                    handled.push(event);
                },
            },
        });

        const processed = await pump.runOnce();

        assert.equal(processed, 2);
        assert.deepEqual(handled, events);
    });
});

async function* eventStream(events: OpenCodeEvent[]): AsyncIterable<OpenCodeEvent> {
    for (const event of events) {
        yield event;
    }
}
