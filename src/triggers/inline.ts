/**
 * Inline trigger — for the terminal-parameter path.
 *
 * Constructs an `Issue` directly from a title/body, with no network and no
 * GitHub issue number. This is what proves the orchestrator and trigger
 * adapter are independent: `runIssue()` takes an `Issue`, and an inline issue
 * is produced without any `Trigger.fetchIssue()` call at all.
 *
 * The automated future (issue-submit/webhook/poll) feeds `Issue` objects in
 * the same way; only the *producer* differs.
 */
import type { Issue, IssueExternalRef } from "../engine/types.js";

export interface InlineIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  external?: IssueExternalRef;
}

export function inlineIssue(input: InlineIssueInput): Issue {
  return {
    source: "inline",
    title: input.title,
    body: input.body ?? "",
    labels: input.labels ?? [],
    external: input.external,
  };
}
