/** Build bounded, auditable context for a fresh continuation run. */
import type { Issue, Run } from "../engine/types.js";
import { formatRunKnowledge } from "../context/runKnowledge.js";

const MAX_INSTRUCTION = 8_000;
const MAX_ROOT_BODY = 6_000;
const MAX_DELIVERABLE = 4_000;
const MAX_FALLBACK_RESULTS = 3;
const MAX_RESULT_OUTPUT = 1_000;

export function buildContinuationIssue(parent: Run, root: Run, instruction: string): Issue {
  const trimmed = instruction.trim();
  if (!trimmed) throw new Error("instruction is required");
  if (trimmed.length > MAX_INSTRUCTION) {
    throw new Error(`instruction must be ${MAX_INSTRUCTION} characters or fewer`);
  }

  const parts = [
    "## Continuation instruction",
    trimmed,
    "",
    "## Run lineage",
    `Root run: ${root.id}`,
    `Parent run: ${parent.id} (${parent.status})`,
    "",
    "## Original issue",
    truncate(root.issue.body || "(no body)", MAX_ROOT_BODY),
  ];

  const final = parent.finalDecision;
  if (final) {
    parts.push("", "## Parent outcome", `Decision: ${final.kind}`, `Reason: ${final.reason}`);
    if (final.kind === "done" && final.deliverable) {
      parts.push("", "Deliverable:", truncate(final.deliverable, MAX_DELIVERABLE));
    }
  }

  const knowledge = formatRunKnowledge(parent.knowledge ?? []);
  if (knowledge) {
    parts.push("", "## Parent run knowledge", knowledge);
  } else if (parent.results.length > 0) {
    parts.push("", "## Recent parent results");
    for (const result of parent.results.slice(-MAX_FALLBACK_RESULTS)) {
      parts.push(
        `### ${result.specialist} (${result.ok ? "ok" : "failed"})`,
        truncate(result.output || result.error || "(no output)", MAX_RESULT_OUTPUT),
      );
    }
  }

  parts.push(
    "",
    "Treat the continuation instruction as the current goal. Inspect the current repository state; do not assume the parent run's files are unchanged.",
  );

  return {
    source: "inline",
    title: parent.issue.title,
    body: parts.join("\n"),
    labels: [...parent.issue.labels],
    external: parent.issue.external,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}
