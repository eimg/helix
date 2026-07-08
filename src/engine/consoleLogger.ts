/**
 * M1 "what's happening now" view: subscribes to the engine EventStream and
 * prints one readable line per event. The same stream is the foundation for
 * M3's dashboards/traces; this is its first consumer.
 */
import type { EventStream } from "./eventStream.js";
import type { RunEvent } from "./types.js";

const COLORS: Record<string, (s: string) => string> = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const TYPE_STYLE: Record<RunEvent["type"], { color: keyof typeof COLORS; icon: string }> = {
  run_started: { color: "cyan", icon: "▶" },
  issue_fetched: { color: "dim", icon: "·" },
  orchestrator_decided: { color: "bold", icon: "↳" },
  specialist_started: { color: "yellow", icon: "→" },
  specialist_finished: { color: "green", icon: "✓" },
  gate_blocked: { color: "red", icon: "⊘" },
  run_done: { color: "green", icon: "■" },
  run_escalated: { color: "yellow", icon: "■" },
  run_error: { color: "red", icon: "✗" },
};

export function attachConsoleLogger(stream: EventStream, runId?: string): () => void {
  return stream.subscribe((event) => {
    const style = TYPE_STYLE[event.type] ?? { color: "dim", icon: "·" };
    const ts = new Date(event.ts).toISOString().slice(11, 19); // HH:MM:SS
    const prefix = runId ? `${COLORS.dim(runId.slice(0, 8))} ` : "";
    const line = `${COLORS.dim(ts)} ${prefix}${COLORS[style.color](`${style.icon} ${event.type}`)} ${event.summary}`;
    console.log(line);
  });
}
