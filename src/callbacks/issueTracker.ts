/**
 * Completion callbacks to external issue trackers (POC — no auth).
 *
 * Follows common webhook conventions:
 *   POST {trackerUrl}/api/webhooks/helix
 *   X-Helix-Event: run.completed
 *   { event, run, issue }
 */
import type { Run } from "../engine/types.js";

export interface RunCompletedPayload {
  event: "run.completed";
  run: {
    id: string;
    status: "done";
    startedAt: number;
    finishedAt?: number;
    parentRunId?: string;
    rootRunId?: string;
  };
  issue: {
    id: number;
    title: string;
  };
}

export interface NotifyIssueTrackerOptions {
  fetchFn?: typeof fetch;
}

export async function notifyIssueTracker(
  run: Run,
  opts: NotifyIssueTrackerOptions = {}
): Promise<void> {
  const external = run.issue.external;
  if (!external || run.status !== "done") return;

  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${external.trackerUrl.replace(/\/$/, "")}/api/webhooks/helix`;
  const payload: RunCompletedPayload = {
    event: "run.completed",
    run: {
      id: run.id,
      status: "done",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      parentRunId: run.parentRunId,
      rootRunId: run.rootRunId,
    },
    issue: {
      id: external.issueId,
      title: run.issue.title,
    },
  };

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Helix-Event": payload.event,
        "X-Helix-Run-Id": run.id,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return;
  } catch {
    /* callback is best-effort for local POC */
  }
}

export function parseIssueExternal(value: unknown): import("../engine/types.js").IssueExternalRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const trackerUrl = typeof o.trackerUrl === "string" ? o.trackerUrl.trim() : "";
  const issueId = typeof o.issueId === "number" ? o.issueId : Number(o.issueId);
  if (!trackerUrl || !Number.isInteger(issueId) || issueId <= 0) return undefined;
  return { trackerUrl, issueId };
}

export function externalFromHeaders(
  headers: Record<string, string | string[] | undefined>
): import("../engine/types.js").IssueExternalRef | undefined {
  const issueIdRaw = headerValue(headers["x-issues-issue-id"]);
  const trackerUrl = headerValue(headers["x-issues-source"]);
  if (!issueIdRaw || !trackerUrl) return undefined;
  const issueId = Number(issueIdRaw);
  if (!Number.isInteger(issueId) || issueId <= 0) return undefined;
  return { trackerUrl: trackerUrl.replace(/\/$/, ""), issueId };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
