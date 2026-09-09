import type { MeshEvent } from "../../protocol/src/index";
import type { EventListener } from "./kernel";

/**
 * EventBus decouples producers (Kernel/Supervisor) from consumers
 * (Scheduler, SSE hub, indexes). Both Supervisor and Scheduler depend on
 * the bus — never on each other — which removes the construction-order
 * cycle that previously required a Proxy in bootstrapMesh.
 */
export interface EventBus {
  subscribe(listener: EventListener): () => void;
  publish(event: MeshEvent): Promise<void>;
}

export class LocalEventBus implements EventBus {
  private listeners: EventListener[] = [];
  constructor(private audit?: (msg: string) => void) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async publish(event: MeshEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (err) {
        this.audit?.(`event-bus listener error on ${event.type}: ${(err as Error).message}`);
      }
    }
  }
}
