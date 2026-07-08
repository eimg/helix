import type { ManageEvent } from "./types.js";

export type ManageEventListener = (event: ManageEvent) => void;

export class ManageEventStream {
  private listeners = new Set<ManageEventListener>();

  subscribe(listener: ManageEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ManageEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener must not break manage flow */
      }
    }
  }
}
