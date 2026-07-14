import type { RunKnowledgeEntry, SpecialistResult } from "../engine/types.js";

const MAX_SUMMARY_CHARS = 2_000;
const MAX_HANDOFF_CHARS = 4_000;
const MAX_ENTRIES_IN_HANDOFF = 6;
const PATH_PATTERN = /(?:^|[\s`'"(])((?:\.?\.?\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),:])/gm;
const COMMAND_PATTERN = /(?:^|\n)\s*(?:[$>]\s*)?((?:npm|pnpm|yarn|bun|npx|node|deno|cargo|go|pytest|python|php|composer|swift|git)\s+[^\n]{1,180})/gim;

export function knowledgeFromResult(result: SpecialistResult): RunKnowledgeEntry {
  return {
    specialist: result.specialist,
    ok: result.ok,
    summary: truncate(result.output || result.error || "(no output)", MAX_SUMMARY_CHARS),
    relevantPaths: uniqueMatches(result.output, PATH_PATTERN, 12),
    verifiedCommands: uniqueMatches(result.output, COMMAND_PATTERN, 8),
  };
}

/** Render only the newest useful entries, bounded for predictable prompt cost. */
export function formatRunKnowledge(entries: RunKnowledgeEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const selected: string[] = [];
  let chars = 0;

  for (const entry of entries.slice(-MAX_ENTRIES_IN_HANDOFF).reverse()) {
    const paths = entry.relevantPaths.length > 0 ? `\nRelevant paths: ${entry.relevantPaths.join(", ")}` : "";
    const commands = entry.verifiedCommands.length > 0 ? `\nReported commands: ${entry.verifiedCommands.join("; ")}` : "";
    const block = `### ${entry.specialist} (${entry.ok ? "ok" : "failed"})\n${entry.summary}${paths}${commands}`;
    if (chars > 0 && chars + block.length > MAX_HANDOFF_CHARS) break;
    selected.push(block);
    chars += block.length;
  }

  return selected.reverse().join("\n\n");
}

function uniqueMatches(text: string, pattern: RegExp, limit: number): string[] {
  const values: string[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value && !values.includes(value)) values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
}
