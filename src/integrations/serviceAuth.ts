export interface ServiceAuthOptions {
  configuredOrigins?: string[];
  envOrigins?: string;
  defaultOrigin: string;
  tokenName: string;
}

/** Optional bearer credential, bound to the configured destination origin. */
export function serviceAuthHeader(
  destination: string,
  token: string | undefined,
  options: ServiceAuthOptions,
): Record<string, string> {
  const value = token?.trim();
  if (!value) return {};
  const origin = normalizeOrigin(destination);
  const allowed = options.configuredOrigins?.map(normalizeOrigin)
    ?? parseTrustedOrigins(options.envOrigins, options.defaultOrigin);
  if (!allowed.includes(origin)) {
    throw new Error(`Refusing to send ${options.tokenName} to untrusted origin: ${origin}`);
  }
  return { Authorization: `Bearer ${value}` };
}

export function preludeServiceAuthHeader(destination: string): Record<string, string> {
  return serviceAuthHeader(destination, process.env.HELIX_PRELUDE_TOKEN, {
    envOrigins: process.env.HELIX_TRUSTED_PRELUDE_ORIGINS,
    defaultOrigin: "http://127.0.0.1:8318",
    tokenName: "HELIX_PRELUDE_TOKEN",
  });
}

export function issuesServiceAuthHeader(destination: string): Record<string, string> {
  return serviceAuthHeader(destination, process.env.HELIX_ISSUES_TOKEN, {
    envOrigins: process.env.HELIX_TRUSTED_ISSUES_ORIGINS,
    defaultOrigin: "http://127.0.0.1:8320",
    tokenName: "HELIX_ISSUES_TOKEN",
  });
}

function parseTrustedOrigins(raw: string | undefined, fallback: string): string[] {
  return (raw ?? fallback).split(",").map((value) => value.trim()).filter(Boolean).map(normalizeOrigin);
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.origin;
  } catch {
    throw new Error(`Invalid trusted service origin: ${value}`);
  }
}
