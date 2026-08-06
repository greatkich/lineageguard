import { EventEmitter } from "node:events";

export interface RunEvent {
  runId: string;
  status: string;
  timestamp: string;
  detail?: string;
}

class EventBus extends EventEmitter {
  publish(event: RunEvent): void {
    this.emit("run-event", event);
  }
}

export const eventBus = new EventBus();
