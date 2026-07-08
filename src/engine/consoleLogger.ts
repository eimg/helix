/**
 * M1 "what's happening now" view: subscribes to the engine EventStream and
 * prints a readable, sectioned log as the run progresses.
 *
 * - Blank lines between phases (orchestrator turn, final result).
 * - Previews use event details — not aggressively truncated summaries.
 */
import type { EventStream } from "./eventStream.js";
import type { OrchestratorDecision, RunEvent } from "./types.js";

const isTTY = process.stdout.isTTY ?? false;

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
  muted: (s: string) => paint("2;36", s),
};

function termWidth(): number {
  return process.stdout.columns && process.stdout.columns > 40 ? process.stdout.columns : 80;
}

function timeStr(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/** Wrap text to width with a hanging indent so wrapped lines align. */
function wrap(text: string, width: number, indent: number): string[] {
  if (!text) return [];
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

function indentBlock(text: string, indent: number, width: number): void {
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      console.log("");
      continue;
    }
    for (const line of wrap(paragraph, width - indent, indent)) {
      console.log(" ".repeat(indent) + line.trimStart());
    }
  }
}

/** First line + a few more lines of body text, capped by char budget. */
function previewText(text: string, maxLines = 4, maxChars = 360): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no output)";
  const allLines = trimmed.split("\n");
  const lines = allLines.slice(0, maxLines);
  let out = lines.join("\n");
  if (allLines.length > maxLines) out += "\n…";
  if (out.length > maxChars) out = `${out.slice(0, maxChars).trimEnd()}…`;
  return out;
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function formatDecisionHead(decision: OrchestratorDecision): string {
  switch (decision.kind) {
    case "run":
      return `run ${decision.specialists.map((s) => s.specialist).join(", ")}`;
    case "done":
      return "done";
    case "escalate":
      return "escalate";
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function printLine(ts: number, tag: string, body: string): void {
  const prefix = `${c.dim(timeStr(ts))}  ${tag}`;
  const prefixLen = 8 + 2 + stripAnsi(tag).length + 2;
  const width = termWidth();
  const wrapped = wrap(body, Math.max(40, width - prefixLen), prefixLen);
  console.log(`${prefix}  ${wrapped[0]}`);
  for (let i = 1; i < wrapped.length; i++) console.log(wrapped[i]);
}

function blankLine(): void {
  console.log("");
}

function handleEvent(event: RunEvent): void {
  switch (event.type) {
    case "run_started": {
      blankLine();
      const title = event.summary.replace(/^Run for /, "");
      printLine(event.ts, `${c.cyan("▶ Run")}`, title);
      break;
    }

    case "issue_fetched": {
      const source = event.details?.source as string | undefined;
      if (source === "inline") break;
      const parts = [event.summary];
      if (event.details?.repo) parts.push(String(event.details.repo));
      printLine(event.ts, c.muted("· issue"), parts.join(" · "));
      break;
    }

    case "orchestrator_decided": {
      blankLine();
      const decision = event.details?.decision as OrchestratorDecision | undefined;
      const iter = event.details?.iteration as number | undefined;
      const iterLabel = iter != null ? c.dim(` · turn ${iter + 1}`) : "";
      const head = decision ? formatDecisionHead(decision) : event.summary;
      printLine(event.ts, `${c.bold("↳ Orchestrator")}${iterLabel}`, head);
      if (decision?.reason) indentBlock(decision.reason, 4, termWidth());
      break;
    }

    case "specialist_started": {
      const name = (event.details?.specialist as string | undefined) ?? event.summary.split(":")[0]?.trim() ?? "specialist";
      const task = (event.details?.task as string | undefined) ?? "";
      printLine(event.ts, `${c.yellow("→")} ${c.bold(name)}`, task ? firstLine(task) : "starting");
      break;
    }

    case "specialist_finished": {
      const name = (event.details?.specialist as string | undefined) ?? event.summary.split(":")[0]?.trim() ?? "specialist";
      const ok = event.details?.ok !== false;
      const output = (event.details?.output as string | undefined) ?? "";
      const error = (event.details?.error as string | undefined) ?? "";
      const statusTag = ok ? c.green("✓") : c.red("✗");
      printLine(event.ts, `${statusTag} ${c.bold(name)}`, ok ? "finished" : "failed");
      const body = ok ? previewText(output) : previewText(error || output || event.summary);
      if (body) indentBlock(body, 4, termWidth());
      break;
    }

    case "gate_blocked": {
      blankLine();
      printLine(event.ts, `${c.red("⊘ Gate")}`, event.summary);
      break;
    }

    case "run_done":
    case "run_escalated":
    case "run_error": {
      blankLine();
      const icon = event.type === "run_done" ? c.green("■ Done") : event.type === "run_escalated" ? c.yellow("▲ Escalated") : c.red("✗ Error");
      printLine(event.ts, icon, event.summary);
      if (event.type === "run_done" && event.details?.deliverable) {
        indentBlock(String(event.details.deliverable), 4, termWidth());
      }
      break;
    }
  }
}

export function attachConsoleLogger(stream: EventStream): () => void {
  return stream.subscribe((event) => {
    try {
      handleEvent(event);
    } catch {
      // logger must never break the engine
    }
  });
}
