/**
 * Resolve a bootstrap export into a local directory for materialize.
 *
 * Soft contract with any export catalog that serves:
 *   GET {base}/api/exports?status=…
 *   GET {base}/api/exports/:id/package  (gzipped tar)
 * Local paths remain supported.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type ExportSourceKind = "local" | "package_url" | "catalog";

export interface ExportSourceMeta {
  kind: ExportSourceKind;
  exportDir: string;
  exportUrl?: string;
  catalogBaseUrl?: string;
  exportId?: number;
  packageUrl?: string;
}

export interface ResolveExportSourceOptions {
  exportPath?: string;
  /** Direct package URL (…/package or any .tgz). */
  exportUrl?: string;
  /** Catalog base URL (no trailing path required). */
  exportCatalogUrl?: string;
  exportId?: number;
  cacheDir?: string;
  fetchFn?: typeof fetch;
}

export interface BootstrapExportCatalogItem {
  id: number;
  inceptionId: number;
  inceptionName: string;
  summary: string;
  version: number;
  createdAt: number;
  adoptionStatus: "available" | "adopted";
  adoptedAt: number | null;
  adoptedBy: string;
  adoptionNote: string;
}

export function normalizeCatalogBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function catalogExportsUrl(
  baseUrl: string,
  status: "all" | "available" | "adopted" | "new" = "all",
): string {
  return `${normalizeCatalogBaseUrl(baseUrl)}/api/exports?status=${status}`;
}

export function catalogPackageUrl(baseUrl: string, exportId: number): string {
  return `${normalizeCatalogBaseUrl(baseUrl)}/api/exports/${exportId}/package`;
}

export function catalogAdoptUrl(baseUrl: string, exportId: number): string {
  return `${normalizeCatalogBaseUrl(baseUrl)}/api/exports/${exportId}/adopt`;
}

export async function listExportCatalog(
  catalogBaseUrl: string,
  status: "all" | "available" | "adopted" | "new" = "all",
  fetchFn: typeof fetch = fetch,
): Promise<BootstrapExportCatalogItem[]> {
  const res = await fetchFn(catalogExportsUrl(catalogBaseUrl, status));
  if (!res.ok) {
    throw new Error(`Export catalog returned HTTP ${res.status}`);
  }
  const body = await res.json() as unknown;
  if (!Array.isArray(body)) throw new Error("Export catalog returned an invalid list");
  return body.map(parseCatalogItem).filter((item): item is BootstrapExportCatalogItem => item !== undefined);
}

export async function resolveExportDirectory(
  opts: ResolveExportSourceOptions,
): Promise<ExportSourceMeta> {
  const exportPath = opts.exportPath?.trim();
  const exportUrl = opts.exportUrl?.trim();
  const catalogBaseUrl = opts.exportCatalogUrl?.trim()
    ? normalizeCatalogBaseUrl(opts.exportCatalogUrl)
    : undefined;
  const exportId = opts.exportId;
  const fetchFn = opts.fetchFn ?? fetch;

  const modes = [
    Boolean(exportPath),
    Boolean(exportUrl),
    Boolean(catalogBaseUrl && exportId !== undefined),
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      "Provide exactly one bootstrap export source: exportPath, exportUrl, or exportCatalogUrl+exportId",
    );
  }

  if (exportPath) {
    return { kind: "local", exportDir: resolve(exportPath) };
  }

  const packageUrl = exportUrl
    ?? (catalogBaseUrl && exportId !== undefined ? catalogPackageUrl(catalogBaseUrl, exportId) : undefined);
  if (!packageUrl) {
    throw new Error("exportUrl or exportCatalogUrl+exportId is required");
  }

  const cacheRoot = opts.cacheDir
    ? resolve(opts.cacheDir)
    : mkdtempSync(join(tmpdir(), "helix-bootstrap-export-"));
  mkdirSync(cacheRoot, { recursive: true });
  const archivePath = join(cacheRoot, "bootstrap-export.tgz");
  const exportDir = join(cacheRoot, "export");
  mkdirSync(exportDir, { recursive: true });

  const res = await fetchFn(packageUrl);
  if (!res.ok) {
    throw new Error(`Bootstrap export package returned HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(archivePath, bytes);
  await execFileP("tar", ["-xzf", archivePath, "-C", exportDir]);

  return {
    kind: catalogBaseUrl ? "catalog" : "package_url",
    exportDir,
    exportUrl: exportUrl || undefined,
    catalogBaseUrl,
    exportId,
    packageUrl,
  };
}

function parseCatalogItem(value: unknown): BootstrapExportCatalogItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const id = Number(o.id);
  const inceptionId = Number(o.inceptionId);
  const version = Number(o.version);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  if (!Number.isInteger(inceptionId) || inceptionId <= 0) return undefined;
  if (!Number.isInteger(version) || version <= 0) return undefined;
  const adoptionStatus = o.adoptionStatus === "adopted" ? "adopted" : "available";
  return {
    id,
    inceptionId,
    inceptionName: typeof o.inceptionName === "string" ? o.inceptionName : "",
    summary: typeof o.summary === "string" ? o.summary.trim() : "",
    version,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Number(o.createdAt) || 0,
    adoptionStatus,
    adoptedAt: o.adoptedAt == null ? null : Number(o.adoptedAt),
    adoptedBy: typeof o.adoptedBy === "string" ? o.adoptedBy : "",
    adoptionNote: typeof o.adoptionNote === "string" ? o.adoptionNote : "",
  };
}
