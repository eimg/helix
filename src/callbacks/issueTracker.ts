/**
 * Completion callbacks to external issue trackers (POC — no auth).
 *
 * Follows common webhook conventions:
 *   POST {trackerUrl}/api/webhooks/helix
 *   X-Helix-Event: run.completed
 *   { event, run, issue }
 *
 * Multi-project Issues trackers (Acme Issues) also send project identity on
 * inbound runs (`external.projectId` / `projectSlug`, `X-Issues-Project-Id`).
 * Helix echoes that onto project-scoped PR registration URLs.
 */
import type { IssueExternalRef, Run } from "../engine/types.js";

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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Helix-Event": payload.event,
      "X-Helix-Run-Id": run.id,
    };
    if (external.projectId !== undefined) {
      headers["X-Issues-Project-Id"] = String(external.projectId);
    }
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) return;
  } catch {
    /* callback is best-effort for local POC */
  }
}

/** Prefer slug, else numeric id, for `/api/projects/:ref/...` routes. */
export function issuesProjectRef(external: {
  projectId?: number;
  projectSlug?: string;
}): string {
  const slug = typeof external.projectSlug === "string" ? external.projectSlug.trim() : "";
  if (slug) return slug;
  if (
    typeof external.projectId === "number" &&
    Number.isInteger(external.projectId) &&
    external.projectId > 0
  ) {
    return String(external.projectId);
  }
  throw new Error("Issues project id or slug is required for project-scoped API calls");
}

export function issuesProjectPullRequestsUrl(
  trackerUrl: string,
  projectRef: string,
  pullRequestId?: number,
): string {
  const base = trackerUrl.replace(/\/$/, "");
  const encoded = encodeURIComponent(projectRef);
  const root = `${base}/api/projects/${encoded}/pull-requests`;
  return pullRequestId === undefined ? root : `${root}/${pullRequestId}`;
}

/** Deep-link into the Issues UI for a local PR within a project. */
export function issuesPullRequestUiUrl(
  trackerUrl: string,
  pullRequestId: number,
  projectRef?: string,
): string {
  const url = new URL(trackerUrl);
  url.search = "";
  url.hash = "";
  if (projectRef) url.searchParams.set("project", projectRef);
  url.searchParams.set("pr", String(pullRequestId));
  return url.toString();
}

export function parseIssueExternal(value: unknown): IssueExternalRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const trackerUrl = typeof o.trackerUrl === "string" ? o.trackerUrl.trim() : "";
  const issueId = typeof o.issueId === "number" ? o.issueId : Number(o.issueId);
  if (!trackerUrl || !Number.isInteger(issueId) || issueId <= 0) return undefined;
  const external: IssueExternalRef = { trackerUrl, issueId };
  const projectId = typeof o.projectId === "number" ? o.projectId : Number(o.projectId);
  if (Number.isInteger(projectId) && projectId > 0) external.projectId = projectId;
  if (typeof o.projectSlug === "string" && o.projectSlug.trim()) {
    external.projectSlug = o.projectSlug.trim();
  }
  return external;
}

export function externalFromHeaders(
  headers: Record<string, string | string[] | undefined>
): IssueExternalRef | undefined {
  const issueIdRaw = headerValue(headers["x-issues-issue-id"]);
  const trackerUrl = headerValue(headers["x-issues-source"]);
  if (!issueIdRaw || !trackerUrl) return undefined;
  const issueId = Number(issueIdRaw);
  if (!Number.isInteger(issueId) || issueId <= 0) return undefined;
  const external: IssueExternalRef = {
    trackerUrl: trackerUrl.replace(/\/$/, ""),
    issueId,
  };
  const projectIdRaw = headerValue(headers["x-issues-project-id"]);
  if (projectIdRaw) {
    const projectId = Number(projectIdRaw);
    if (Number.isInteger(projectId) && projectId > 0) external.projectId = projectId;
  }
  return external;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
