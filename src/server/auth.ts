import type {
  NextFunction,
  Request,
  RequestHandler,
  Response as ExpressResponse,
} from "express";

export type HelixPrincipal = {
  id: string;
  issuer: string;
  username: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  kind: "human" | "service" | "development";
};

export type AuthRequest = {
  authorization?: string;
  cookie?: string;
};

export type SessionResult = {
  status: number;
  body: unknown;
  setCookie?: string;
};

/** Helix-owned seam. Providers translate their native identity into this shape. */
export interface HelixAuthAdapter {
  readonly provider: string;
  readonly accountUrl?: string;
  resolve(request: AuthRequest): Promise<HelixPrincipal>;
  signIn?(credentials: unknown, request: AuthRequest): Promise<SessionResult>;
  signOut?(request: AuthRequest): Promise<SessionResult>;
}

export class HelixAuthError extends Error {
  constructor(
    message: string,
    readonly code: "unauthenticated" | "unavailable" | "config",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HelixAuthError";
  }
}

type AuthLocals = { principal?: HelixPrincipal };

const HELIX_CAPABILITIES = [
  "helix.read",
  "helix.trigger",
  "helix.review",
  "helix.merge",
  "helix.bootstrap",
  "helix.manage",
  "helix.admin",
];

const standalonePrincipal: HelixPrincipal = {
  id: "standalone:admin",
  issuer: "helix",
  username: "admin",
  displayName: "Local Helix operator",
  roles: ["admin"],
  permissions: ["*"],
  kind: "development",
};

export function createStandaloneAuthAdapter(): HelixAuthAdapter {
  return {
    provider: "standalone",
    async resolve() {
      return standalonePrincipal;
    },
  };
}

export function createAcmeIdentityAuthAdapter({
  baseUrl = process.env.HELIX_AUTH_URL ?? "http://127.0.0.1:8316",
  fetchFn = fetch,
  timeoutMs = 3_000,
}: {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} = {}): HelixAuthAdapter {
  const identityUrl = baseUrl.replace(/\/$/, "");

  const call = async (
    path: string,
    init: RequestInit,
    unavailableMessage: string,
  ): Promise<globalThis.Response> => {
    try {
      return await fetchFn(`${identityUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new HelixAuthError(unavailableMessage, "unavailable", { cause: error });
    }
  };

  return {
    provider: "acme-identity",
    accountUrl: `${identityUrl}/?tab=account`,
    async resolve(request) {
      const response = await call(
        "/api/principal",
        { method: "GET", headers: forwardedHeaders(request) },
        `Authentication provider unavailable at ${identityUrl}`,
      );
      if (response.status === 401) {
        throw new HelixAuthError("Authentication required", "unauthenticated");
      }
      if (!response.ok) {
        throw new HelixAuthError(
          `Authentication provider lookup failed (${response.status})`,
          "unavailable",
        );
      }
      return translateAcmePrincipal(await response.json());
    },
    async signIn(credentials, request) {
      const response = await call(
        "/api/session",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...forwardedHeaders(request) },
          body: JSON.stringify(credentials ?? {}),
        },
        `Authentication provider unavailable at ${identityUrl}`,
      );
      return sessionResult(response);
    },
    async signOut(request) {
      const response = await call(
        "/api/session",
        { method: "DELETE", headers: forwardedHeaders(request) },
        `Authentication provider unavailable at ${identityUrl}`,
      );
      return sessionResult(response);
    },
  };
}

export function createAuthAdapterFromEnv(
  provider = process.env.HELIX_AUTH_PROVIDER ?? "standalone",
): HelixAuthAdapter {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "standalone") return createStandaloneAuthAdapter();
  if (normalized === "acme-identity") return createAcmeIdentityAuthAdapter();
  throw new HelixAuthError(
    `HELIX_AUTH_PROVIDER must be "standalone" or "acme-identity" (got ${JSON.stringify(provider)})`,
    "config",
  );
}

export function sessionRoutes(app: import("express").Express, adapter: HelixAuthAdapter): void {
  app.get("/auth/session", async (req, res) => {
    try {
      res.json({
        schemaVersion: "helix.session.v1",
        provider: adapter.provider,
        accountUrl: adapter.accountUrl,
        principal: await adapter.resolve(authRequest(req)),
      });
    } catch (error) {
      authError(res, error);
    }
  });
  app.post("/auth/session", async (req, res) => {
    if (!adapter.signIn) {
      res.status(405).json({ error: "Interactive sign-in is unavailable for this auth provider" });
      return;
    }
    try {
      sendSessionResult(res, await adapter.signIn(req.body, authRequest(req)));
    } catch (error) {
      authError(res, error);
    }
  });
  app.delete("/auth/session", async (req, res) => {
    if (!adapter.signOut) {
      res.json({ schemaVersion: "helix.session.v1", signedOut: true });
      return;
    }
    try {
      sendSessionResult(res, await adapter.signOut(authRequest(req)));
    } catch (error) {
      authError(res, error);
    }
  });
}

export function authenticateRequests(adapter: HelixAuthAdapter): RequestHandler {
  return async (req, res, next) => {
    try {
      (res.locals as AuthLocals).principal = await adapter.resolve(authRequest(req));
      next();
    } catch (error) {
      authError(res, error);
    }
  };
}

export function authorizeHelixRequest(req: Request, res: ExpressResponse, next: NextFunction): void {
  const principal = (res.locals as AuthLocals).principal;
  if (!principal) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const required = requiredPermission(req);
  if (required === "helix.read") {
    if (HELIX_CAPABILITIES.some((permission) => hasPermission(principal, permission))) {
      next();
      return;
    }
    res.status(403).json({ error: "Missing Helix permission" });
    return;
  }
  if (!hasPermission(principal, required)) {
    res.status(403).json({ error: `Missing permission: ${required}` });
    return;
  }
  next();
}

export function sameOriginWrites(): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const site = req.headers["sec-fetch-site"];
    if (site === "same-origin" || site === "none") {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const expected = `${req.protocol}://${req.headers.host ?? ""}`;
    if (origin.replace(/\/$/, "") === expected) {
      next();
      return;
    }
    res.status(403).json({ error: "Cross-origin request blocked" });
  };
}

export function hasPermission(principal: HelixPrincipal, requested: string): boolean {
  return principal.permissions.some((granted) =>
    granted === "*"
    || granted === requested
    || (granted.endsWith(".*") && requested.startsWith(granted.slice(0, -1))),
  );
}

function requiredPermission(req: Request): string {
  if (req.method === "GET" || req.method === "HEAD") return "helix.read";
  if (req.method === "DELETE" && /^\/runs\/[^/]+$/.test(req.path)) return "helix.admin";
  if (req.method === "POST" && req.path === "/api/steering/actions") return "helix.steering.recover";
  if (req.method === "POST" && req.path === "/api/steering/decisions") return "helix.steering.receive";
  if (
    req.method === "POST"
    && (req.path === "/runs" || /\/(continuations|pause|resume)$/.test(req.path))
  ) {
    return "helix.trigger";
  }
  if (req.method === "POST" && req.path === "/pr-reviews") return "helix.review";
  if (
    req.method === "POST"
    && (req.path === "/local-prs/merge" || /\/runs\/[^/]+\/(approve|reject)$/.test(req.path))
  ) {
    return "helix.merge";
  }
  if (req.method === "POST" && req.path === "/bootstrap") return "helix.bootstrap";
  if (req.path.startsWith("/manage/")) return "helix.manage";
  return "helix.admin";
}

function authRequest(req: Request): AuthRequest {
  return { authorization: req.headers.authorization, cookie: req.headers.cookie };
}

function forwardedHeaders(request: AuthRequest): Record<string, string> {
  return {
    ...(request.authorization ? { authorization: request.authorization } : {}),
    ...(request.cookie ? { cookie: request.cookie } : {}),
  };
}

async function sessionResult(response: globalThis.Response): Promise<SessionResult> {
  return {
    status: response.status,
    body: await response.json().catch(() => ({ error: response.statusText })),
    setCookie: response.headers.get("set-cookie") ?? undefined,
  };
}

function sendSessionResult(res: ExpressResponse, result: SessionResult): void {
  if (result.setCookie) res.setHeader("set-cookie", result.setCookie);
  res.status(result.status).json(result.body);
}

function authError(res: ExpressResponse, error: unknown): void {
  const status = error instanceof HelixAuthError && error.code === "unauthenticated" ? 401 : 503;
  res.status(status).json({
    error: error instanceof Error ? error.message : "Authentication required",
  });
}

function translateAcmePrincipal(value: unknown): HelixPrincipal {
  if (!value || typeof value !== "object") {
    throw new HelixAuthError("Authentication provider returned an invalid principal", "unavailable");
  }
  const principal = value as Record<string, unknown>;
  const sub = text(principal.sub);
  const issuer = text(principal.iss);
  const username = text(principal.username);
  const displayName = text(principal.displayName);
  const roles = strings(principal.roles);
  const permissions = strings(principal.permissions);
  if (!sub || !issuer || !username || !displayName || !roles || !permissions) {
    throw new HelixAuthError("Authentication provider returned an invalid principal", "unavailable");
  }
  const kind = principal.kind === "service"
    ? "service"
    : principal.kind === "dev" ? "development" : "human";
  return { id: sub, issuer, username, displayName, roles, permissions, kind };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map((item) => item.trim()).filter(Boolean)
    : undefined;
}
