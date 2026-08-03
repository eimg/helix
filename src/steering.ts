import type { AppSettingsStore } from "./state/appSettings.js";

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

export interface SteeringEnvironmentConfig {
  baseUrl?: string;
  token?: string;
  trustedOrigins?: string;
}

export interface SteeringIntegrationStatus {
  configured: boolean;
  url: string;
  source: "stored" | "environment" | "unconfigured";
  status: "online" | "offline" | "unconfigured";
  detail: string;
  checkedAt: string;
  credentialConfigured: boolean;
  credentialWillBeSent: boolean;
  startupConfigured: boolean;
}

const STEERING_URL_SETTING = "steering.url";

export function steeringEnvironmentFromProcess(): SteeringEnvironmentConfig {
  return {
    baseUrl: process.env.ACME_STEERING_URL,
    token: process.env.ACME_STEERING_TOKEN,
    trustedOrigins: process.env.ACME_TRUSTED_STEERING_ORIGINS,
  };
}

export function resolveSteeringConfig(
  settings: AppSettingsStore,
  environment: SteeringEnvironmentConfig,
): SteeringEnvironmentConfig & { source: SteeringIntegrationStatus["source"] } {
  const stored = settings.get(STEERING_URL_SETTING);
  if (stored !== undefined) {
    return { ...environment, baseUrl: stored.trim() || undefined, source: "stored" };
  }
  if (environment.baseUrl?.trim()) {
    return { ...environment, baseUrl: environment.baseUrl.trim(), source: "environment" };
  }
  return { ...environment, baseUrl: undefined, source: "unconfigured" };
}

export function setSteeringUrl(settings: AppSettingsStore, value: string): string {
  const url = value.trim() ? normalizeSteeringUrl(value) : "";
  settings.set(STEERING_URL_SETTING, url);
  return url;
}

export function clearSteeringUrl(settings: AppSettingsStore): void {
  settings.delete(STEERING_URL_SETTING);
}

export async function probeSteeringIntegration(
  settings: AppSettingsStore,
  fetchFn: typeof fetch,
  environment: SteeringEnvironmentConfig,
): Promise<SteeringIntegrationStatus> {
  const config = resolveSteeringConfig(settings, environment);
  const checkedAt = new Date().toISOString();
  const credentialConfigured = Boolean(config.token?.trim());
  const startupConfigured = Boolean(environment.baseUrl?.trim());
  if (!config.baseUrl) {
    return {
      configured: false,
      url: "",
      source: config.source,
      status: "unconfigured",
      detail: config.source === "stored" ? "Steering notifications are disabled in Helix." : "No Steering URL is configured.",
      checkedAt,
      credentialConfigured,
      credentialWillBeSent: false,
      startupConfigured,
    };
  }
  try {
    const url = normalizeSteeringUrl(config.baseUrl);
    const trusted = trustedOriginSet(config.trustedOrigins);
    const credentialWillBeSent = credentialConfigured && trusted.has(new URL(url).origin);
    const response = await fetchFn(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
    const body = response.ok ? await response.json().catch(() => undefined) as { product?: string } | undefined : undefined;
    const steeringEndpoint = response.ok && body?.product === "acme-steering";
    if (!steeringEndpoint) {
      return {
        configured: true,
        url,
        source: config.source,
        status: "offline",
        detail: `The endpoint did not identify as Acme Steering (${response.status}).`,
        checkedAt,
        credentialConfigured,
        credentialWillBeSent,
        startupConfigured,
      };
    }
    const credentialResponse = await fetchFn(`${url}/api/notifications/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credentialWillBeSent ? { authorization: `Bearer ${config.token!.trim()}` } : {}),
      },
      body: JSON.stringify({ product: "helix" }),
      signal: AbortSignal.timeout(2_000),
    });
    const online = credentialResponse.ok;
    return {
      configured: true,
      url,
      source: config.source,
      status: online ? "online" : "offline",
      detail: online
        ? "Acme Steering is reachable and accepts Helix notifications."
        : `Acme Steering is reachable, but the Helix notification credential was rejected (${credentialResponse.status}).`,
      checkedAt,
      credentialConfigured,
      credentialWillBeSent,
      startupConfigured,
    };
  } catch (error) {
    return {
      configured: true,
      url: config.baseUrl,
      source: config.source,
      status: "offline",
      detail: error instanceof Error ? error.message : String(error),
      checkedAt,
      credentialConfigured,
      credentialWillBeSent: false,
      startupConfigured,
    };
  }
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
  baseUrl: string | undefined | (() => SteeringEnvironmentConfig) = process.env.ACME_STEERING_URL,
  token = process.env.ACME_STEERING_TOKEN,
  trustedOrigins = process.env.ACME_TRUSTED_STEERING_ORIGINS,
): (notification: SteeringNotification) => void {
  return (notification) => {
    const config = typeof baseUrl === "function" ? baseUrl() : { baseUrl, token, trustedOrigins };
    let endpoint: string;
    try {
      if (!config.baseUrl?.trim()) return;
      endpoint = `${normalizeSteeringUrl(config.baseUrl)}/api/notifications`;
    } catch {
      console.warn(`[steering] invalid Steering URL: ${config.baseUrl}`);
      return;
    }
    const attachToken = Boolean(
      config.token?.trim()
      && trustedOriginSet(config.trustedOrigins).has(new URL(endpoint).origin),
    );
    void fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(attachToken ? { authorization: `Bearer ${config.token!.trim()}` } : {}),
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

function normalizeSteeringUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Steering URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Steering URL cannot contain credentials, a query, or a fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function trustedOriginSet(value?: string): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
