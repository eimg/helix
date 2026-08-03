export interface SteeringNotification {
  schemaVersion: "acme.steering.notification.v1";
  id: string;
  source: {
    product: "helix";
    instanceId?: string;
    resourceType: string;
    resourceId: string;
    revision: string;
    url?: string;
  };
  event: {
    type: string;
    occurredAt: string;
    summary: string;
    detail?: string;
  };
  steering?: {
    caseKey: string;
    state: "open" | "resolved" | "withdrawn" | "superseded";
    kind?: "decision" | "clarification" | "revision" | "exception" | "escalation" | "intervention";
    title?: string;
    action?: string;
    reason?: string;
    proposedAction?: string;
    recommendation?: string;
    risk?: "low" | "medium" | "high";
    reversible?: boolean;
    facts?: Record<string, string | number | boolean | undefined>;
  };
}

export interface SteeringActionRequest {
  schemaVersion: "acme.steering.action.v1";
  requestId: string;
  caseId: string;
  decisionId: string;
  actionKey: string;
  resource: { type: string; id: string; expectedRevision: string };
  input?: Record<string, unknown>;
}

export interface SteeringActionReceipt {
  schemaVersion: "acme.steering.action-receipt.v1";
  requestId: string;
  status: "applied" | "already_applied" | "accepted" | "stale" | "rejected" | "unavailable";
  sourceRevision: string;
  summary: string;
  eventId?: string;
  operationId?: string;
}

export interface SteeringDecisionNotice {
  schemaVersion: "acme.steering.decision.v1";
  decisionId: string;
  caseId: string;
  actionKey: string;
  resolution: "approve" | "reject" | "request_revision" | "defer" | "escalate" | "cancel";
  rationale: string;
  decidedAt: string;
  actor: { id: string; issuer: string; username: string; displayName: string; kind: "human" | "service" | "development" };
  resource: { type: string; id: string; expectedRevision: string };
}

export interface SteeringDecisionReceipt {
  schemaVersion: "acme.steering.decision-receipt.v1";
  decisionId: string;
  status: "recorded" | "already_recorded" | "stale" | "rejected" | "unavailable";
  sourceRevision: string;
  summary: string;
}

export function parseSteeringActionRequest(value: unknown): SteeringActionRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SteeringActionRequest>;
  if (item.schemaVersion !== "acme.steering.action.v1" || !text(item.requestId) || !text(item.caseId)
    || !text(item.decisionId) || !text(item.actionKey) || !item.resource
    || !text(item.resource.type) || !text(item.resource.id) || !text(item.resource.expectedRevision)) return undefined;
  return item as SteeringActionRequest;
}

export function parseSteeringDecisionNotice(value: unknown): SteeringDecisionNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SteeringDecisionNotice>;
  if (item.schemaVersion !== "acme.steering.decision.v1" || !text(item.decisionId) || !text(item.caseId)
    || !text(item.actionKey) || !["approve", "reject", "request_revision", "defer", "escalate", "cancel"].includes(String(item.resolution))
    || typeof item.rationale !== "string" || !text(item.decidedAt) || Number.isNaN(Date.parse(String(item.decidedAt)))
    || !item.actor || !text(item.actor.id) || !text(item.actor.issuer) || !text(item.actor.username)
    || !text(item.actor.displayName) || !["human", "service", "development"].includes(String(item.actor.kind))
    || !item.resource || !text(item.resource.type) || !text(item.resource.id) || !text(item.resource.expectedRevision)) return undefined;
  return item as SteeringDecisionNotice;
}

export function createSteeringNotifier(
  fetchFn: typeof fetch = fetch,
  baseUrl = process.env.ACME_STEERING_URL,
  token = process.env.ACME_STEERING_TOKEN,
  trustedOrigins = process.env.ACME_TRUSTED_STEERING_ORIGINS,
): (notification: SteeringNotification) => void {
  const endpoint = baseUrl?.trim() ? `${baseUrl.replace(/\/$/, "")}/api/notifications` : undefined;
  const trusted = new Set((trustedOrigins ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  let attachToken = false;
  if (endpoint) {
    try {
      attachToken = Boolean(token?.trim() && trusted.has(new URL(endpoint).origin));
    } catch {
      console.warn(`[steering] invalid ACME_STEERING_URL: ${baseUrl}`);
      return () => undefined;
    }
  }
  return (notification) => {
    if (!endpoint) return;
    void fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(attachToken ? { authorization: `Bearer ${token!.trim()}` } : {}),
      },
      body: JSON.stringify({
        ...notification,
        source: { ...notification.source, instanceId: notification.source.instanceId ?? process.env.ACME_STEERING_INSTANCE_ID ?? "default" },
      }),
      signal: AbortSignal.timeout(2_000),
    }).then((response) => {
      if (!response.ok) console.warn(`[steering] notification rejected (${response.status}): ${notification.id}`);
    }).catch((error: unknown) => {
      console.warn(`[steering] notification unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
