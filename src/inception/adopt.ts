/**
 * Best-effort adoption callback to an export catalog after successful bootstrap.
 * Soft coupling — failures are ignored.
 */
import { catalogAdoptUrl } from "./pickup.js";

export interface NotifyExportAdoptedOptions {
  catalogBaseUrl: string;
  exportId: number;
  adoptedBy?: string;
  adoptionNote?: string;
  fetchFn?: typeof fetch;
}

export async function notifyExportAdopted(opts: NotifyExportAdoptedOptions): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = catalogAdoptUrl(opts.catalogBaseUrl, opts.exportId);
  try {
    await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adoptedBy: opts.adoptedBy?.trim() || "helix",
        adoptionNote: opts.adoptionNote?.trim() || "",
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* best-effort */
  }
}
