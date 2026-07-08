/**
 * M1 "what's happening now" view: subscribes to the engine EventStream and
 * prints a clean, readable line per event.
 *
 * - Colors only when stdout is a TTY (pipes/logs get plain text).
 * - Human-readable labels, not machine event type names.
 * - Long summaries wrap at the terminal width with hanging indent.
 * - Visual hierarchy: phase markers vs steps vs results.
 */
import type { EventStream } from "./eventStream.js";
import type { RunEvent } from "./types.js";

const isTTY = process.stdout.isTTY ?? false;

// --- minimal color helpers (no-ops when not a TTY) ---------------------------
function paint(code: string, s: string): string {
  return isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const c = {
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
  cyan: (s: string) => paint("36", s),
  green: (s: string) => paint("32", s),
  yellow: (s: string) => paint("33", s),
  red: (s: string) => paint("31", s),
  accent: (s: string) => paint("36", s),
  muted: (s: string) => paint("2;36", s),
};

// --- event styling -----------------------------------------------------------
interface Style {
  label: string; // human-readable, short
  color: (s: string) => string;
  icon: string;
}

const STYLES: Record<RunEvent["type"], Style> = {
  run_started: { label: "run", color: c.cyan, icon: "▶" },
  issue_fetched: { label: "issue", color: c.muted, icon: "·" },
  orchestrator_decided: { label: "orchestrator", color: c.bold, icon: "↳" },
  specialist_started: { label: "start", color: c.yellow, icon: "→" },
  specialist_finished: { label: "done", color: c.green, icon: "✓" },
  gate_blocked: { label: "gate", color: c.red, icon: "⊘" },
  run_done: { label: "result", color: c.green, icon: "■" },
  run_escalated: { label: "result", color: c.yellow, icon: "▲" },
  run_error: { label: "error", color: c.red, icon: "✗" },
};

// --- terminal width + wrapping ----------------------------------------------
function termWidth(): number {
  return (process.stdout.columns && process.stdout.columns > 40) ? process.stdout.columns : 80;
}

function timeStr(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/** Wrap text to width with a hanging indent so wrapped lines align. */
function wrap(text: string, width: number, indent: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  const words = text.split(/\s+/);
  let line = "";
  const pad = " ".repeat(indent);
  for (const word of words) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line.trim());
      line = pad + word;
    } else {
      line += " " + word;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function attachConsoleLogger(stream: EventStream): () => void {
  return stream.subscribe((event) => {
    const style = STYLES[event.type] ?? { label: event.type, color: c.dim, icon: "·" };

    const ts = c.dim(timeStr(event.ts));
    const tag = style.color(`${style.icon} ${style.label}`);
    const width = termWidth();
    // "HH:MM:SS  icon label  summary..." — prefix length
    const prefixLen = 8 + 2 + style.label.length + 3; // ts + "  " + "icon label" + "   "
    const summaryWidth = width - prefixLen;

    const wrapped = wrap(event.summary, Math.max(40, summaryWidth), prefixLen);
    console.log(`${ts}  ${tag}  ${wrapped[0]}`);
    for (let i = 1; i < wrapped.length; i++) console.log(wrapped[i]);
  });
}
