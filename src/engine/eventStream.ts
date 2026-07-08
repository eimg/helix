/**
 * A minimal typed event stream. The engine emits RunEvents; consumers
 * (console logger in M1, future web UI / observability in M3+) subscribe.
 */
import type { RunEvent } from "./types.js";

export type RunEventListener = (event: RunEvent) => void;

export class EventStream {
  private listeners = new Set<RunEventListener>();

  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a listener must never break the engine
      }
    }
  }
}
