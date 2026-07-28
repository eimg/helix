import type {
  PullRequestReview,
  PullRequestReviewCallbackPayload,
} from "./types.js";
import { issuesServiceAuthHeader } from "../integrations/serviceAuth.js";

export async function notifyPullRequestTracker(
  review: PullRequestReview,
  event: PullRequestReviewCallbackPayload["event"],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = `${review.request.callback.trackerUrl.replace(/\/$/, "")}/api/webhooks/helix`;
  const payload: PullRequestReviewCallbackPayload = {
    event,
    review: {
      id: review.id,
      status: review.status,
      headSha: review.request.pullRequest.headSha,
      startedAt: review.startedAt,
      finishedAt: review.finishedAt,
      decision: review.decision,
      summary: review.summary,
      findings: review.findings,
      checks: review.checks,
    },
    pullRequest: {
      id: review.request.callback.pullRequestId,
    },
  };

  try {
    await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Helix-Event": event,
        "X-Helix-Review-Id": review.id,
        ...issuesServiceAuthHeader(url),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort local callback. Durable review state remains in Helix.
  }
}
