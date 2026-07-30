/**
 * Process-local control signal for a live run. Durable state remains on Run;
 * this object only lets the HTTP host request a pause while an await is active.
 */
export class RunExecutionControl {
  private requested = false;
  private reason = "Paused by operator";
  private listener: ((reason: string) => void) | undefined;

  requestPause(reason = "Paused by operator"): boolean {
    if (this.requested) return false;
    this.requested = true;
    this.reason = reason;
    this.listener?.(reason);
    return true;
  }

  get pauseRequested(): boolean {
    return this.requested;
  }

  get pauseReason(): string {
    return this.reason;
  }

  bind(listener: (reason: string) => void): () => void {
    this.listener = listener;
    if (this.requested) listener(this.reason);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }
}
