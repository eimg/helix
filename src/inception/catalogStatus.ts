/**
 * Soft reachability probe for an export catalog base URL.
 * Tries `/api/health` then `/health` for `{ ok: true }` — no product coupling.
 */
import { normalizeCatalogBaseUrl } from "./pickup.js";

export type ExportCatalogReachability = "online" | "offline" | "unconfigured";

export interface ExportCatalogStatus {
  status: ExportCatalogReachability;
  catalogBaseUrl: string;
  healthUrl: string | null;
  checkedAt: number;
}

const HEALTH_SUFFIXES = ["/api/health", "/health"] as const;

export function catalogHealthCandidates(baseUrl: string): string[] {
  const base = normalizeCatalogBaseUrl(baseUrl);
  if (!base) return [];
  return HEALTH_SUFFIXES.map((suffix) => `${base}${suffix}`);
}

export async function probeExportCatalogStatus(
  catalogBaseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ExportCatalogStatus> {
  const checkedAt = Date.now();
  const normalized = catalogBaseUrl.trim() ? normalizeCatalogBaseUrl(catalogBaseUrl) : "";
  if (!normalized) {
    return {
      status: "unconfigured",
      catalogBaseUrl: "",
      healthUrl: null,
      checkedAt,
    };
  }

  const candidates = catalogHealthCandidates(normalized);
  for (const healthUrl of candidates) {
    try {
      const res = await fetchFn(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(2_500),
      });
      if (!res.ok || res.status !== 200) continue;
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (body && body.ok === true) {
        return {
          status: "online",
          catalogBaseUrl: normalized,
          healthUrl,
          checkedAt,
        };
      }
    } catch {
      /* try next candidate */
    }
  }

  return {
    status: "offline",
    catalogBaseUrl: normalized,
    healthUrl: candidates[0] ?? null,
    checkedAt,
  };
}
