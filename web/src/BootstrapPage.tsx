import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BootstrapAcceptedResult,
  BootstrapExecuteResult,
  BootstrapPreview,
  WorkspaceStatus,
} from "../../src/inception/service";
import type { InceptionJob } from "../../src/inception/job";
import type { BootstrapExportCatalogItem } from "../../src/inception/pickup";
import type { ExportCatalogStatus } from "../../src/inception/catalogStatus";
import { api } from "./api";

type BootstrapResult = BootstrapPreview | BootstrapExecuteResult | BootstrapAcceptedResult;
type SourceMode = "catalog" | "path" | "url";
type CatalogFilter = "all" | "new" | "adopted";

const CATALOG_URL_KEY = "helix.bootstrap.exportCatalogUrl";

export function BootstrapPage() {
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api<WorkspaceStatus>("/workspace"),
    refetchInterval: (query) => {
      const state = query.state.data?.bootstrap.state;
      return state === "running" ? 1500 : false;
    },
  });
  const [sourceMode, setSourceMode] = useState<SourceMode>("catalog");
  const [exportPath, setExportPath] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const [catalogUrl, setCatalogUrl] = useState(() => {
    try {
      return localStorage.getItem(CATALOG_URL_KEY) ?? "http://127.0.0.1:8321";
    } catch {
      return "http://127.0.0.1:8321";
    }
  });
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  const [selectedExportId, setSelectedExportId] = useState<number | null>(null);
  const [force, setForce] = useState(false);
  const [last, setLast] = useState<BootstrapResult | null>(null);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(CATALOG_URL_KEY, catalogUrl.trim());
    } catch {
      /* ignore */
    }
  }, [catalogUrl]);

  const catalog = useQuery({
    queryKey: ["bootstrap-export-catalog", catalogUrl.trim()],
    queryFn: () =>
      api<BootstrapExportCatalogItem[]>(
        `/bootstrap/export-catalog?baseUrl=${encodeURIComponent(catalogUrl.trim())}&status=all`,
      ),
    enabled: false,
  });

  const catalogStatus = useQuery({
    queryKey: ["bootstrap-export-catalog-status", catalogUrl.trim()],
    queryFn: () =>
      api<ExportCatalogStatus>(
        `/bootstrap/export-catalog/status?baseUrl=${encodeURIComponent(catalogUrl.trim())}`,
      ),
    enabled: sourceMode === "catalog" && Boolean(catalogUrl.trim()),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });

  const catalogExports = useMemo(() => {
    const sorted = sortCatalogExports(catalog.data ?? []);
    if (catalogFilter === "new") {
      return sorted.filter((item) => item.adoptionStatus === "available");
    }
    if (catalogFilter === "adopted") {
      return sorted.filter((item) => item.adoptionStatus === "adopted");
    }
    return sorted;
  }, [catalog.data, catalogFilter]);

  useEffect(() => {
    if (!catalogExports.length) return;
    if (selectedExportId != null && catalogExports.some((item) => item.id === selectedExportId)) {
      return;
    }
    const preferred = catalogExports.find((item) => item.adoptionStatus === "available")
      ?? catalogExports[0];
    setSelectedExportId(preferred?.id ?? null);
  }, [catalogExports, selectedExportId]);

  const bootstrapBody = () => {
    if (sourceMode === "path") {
      return { exportPath: exportPath.trim() };
    }
    if (sourceMode === "url") {
      return { exportUrl: exportUrl.trim() };
    }
    return {
      exportCatalogUrl: catalogUrl.trim(),
      exportId: selectedExportId ?? undefined,
    };
  };

  const sourceReady = () => {
    if (sourceMode === "path") return Boolean(exportPath.trim());
    if (sourceMode === "url") return Boolean(exportUrl.trim());
    return Boolean(catalogUrl.trim() && selectedExportId);
  };

  const dryRun = useMutation({
    mutationFn: () =>
      api<BootstrapPreview>("/bootstrap", {
        method: "POST",
        body: JSON.stringify({ ...bootstrapBody(), dryRun: true, force }),
      }),
    onSuccess: (data) => setLast(data),
  });

  const execute = useMutation({
    mutationFn: () =>
      api<BootstrapExecuteResult | BootstrapAcceptedResult>("/bootstrap", {
        method: "POST",
        body: JSON.stringify({ ...bootstrapBody(), execute: true, force }),
      }),
    onSuccess: async (data) => {
      setLast(data);
      await client.invalidateQueries({ queryKey: ["workspace"] });
      await client.invalidateQueries({ queryKey: ["manage-inception-agents"] });
      await client.invalidateQueries({ queryKey: ["manage-inception-skills"] });
      await client.invalidateQueries({ queryKey: ["config-snapshot"] });
      await client.invalidateQueries({ queryKey: ["bootstrap-export-catalog"] });
    },
  });

  const runAgents = useMutation({
    mutationFn: () =>
      api<BootstrapExecuteResult | BootstrapAcceptedResult>("/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          runAgents: true,
          exportPath: exportPath.trim() || undefined,
        }),
      }),
    onSuccess: async (data) => {
      setLast(data);
      await client.invalidateQueries({ queryKey: ["workspace"] });
    },
  });

  const status = workspace.data;
  const specialists = status?.inception.specialists ?? [];
  const skills = status?.inception.skills ?? [];
  const state = status?.bootstrap.state;
  const available = state === "ready";
  const completed = state === "completed";
  const canRunAgents = status?.bootstrap.canRunAgents === true;
  const running = state === "running";
  const failed = state === "failed";
  const awaitingAgents = state === "awaiting_agents";
  const busy = dryRun.isPending || execute.isPending || runAgents.isPending || running;
  const error =
    dryRun.error?.message ??
    execute.error?.message ??
    runAgents.error?.message ??
    catalog.error?.message ??
    workspace.error?.message;
  const job = status?.bootstrap.job;

  const submitDryRun = (event: FormEvent) => {
    event.preventDefault();
    if (!sourceReady() || !available) return;
    dryRun.mutate();
  };

  const loadCatalog = async () => {
    setCatalogLoaded(true);
    setSelectedExportId(null);
    await catalog.refetch();
  };

  const chipLabel = workspace.isPending
    ? "checking"
    : running
      ? "agents running"
      : awaitingAgents
        ? "awaiting agents"
        : failed
          ? "failed"
          : available
            ? busy
              ? "working"
              : "ready"
            : completed
              ? "done"
              : "unavailable";
  const chipTone =
    running || (available && busy)
      ? "running"
      : completed
        ? "done"
        : failed
          ? "error"
          : awaitingAgents
            ? "running"
            : workspace.isPending
              ? "idle"
              : available
                ? "done"
                : "error";

  return (
    <main className="workspace bootstrap-workspace">
      <div className="top-grid">
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">
                {completed || awaitingAgents || failed || running
                  ? "Project inception"
                  : "Empty-workspace inception"}
              </span>
              <h2>Bootstrap</h2>
              <p className="panel-description">
                {completed
                  ? "This project's bootstrap is complete. Here's the inception status and foundation outcome."
                  : awaitingAgents || failed
                    ? "Export is on disk. Run architect → scaffolder → validator to build the project foundation (requires OPENROUTER_API_KEY in .env)."
                    : running
                      ? "Inception agents are building the project foundation…"
                      : "Pick a bootstrap export, then create git + Helix wiring and run bootstrap specialists with auto-loaded inception skills."}
              </p>
            </div>
            <StatusChip label={chipLabel} tone={chipTone} />
          </div>

          {status && completed && (
            <div className="bootstrap-banner bootstrap-banner-success" role="status">
              <p>{status.bootstrap.reason}</p>
              {job && <JobProgress job={job} />}
              <div className="form-actions" style={{ marginTop: 10 }}>
                <a className="btn btn-primary" href="/">Open Run</a>
                <a className="btn btn-ghost" href="/manage">Manage</a>
                <a className="btn btn-ghost" href="/reviews">PR Reviews</a>
              </div>
            </div>
          )}

          {status && state === "blocked" && (
            <p className="bootstrap-banner bootstrap-banner-blocked" role="status">
              {status.bootstrap.reason}
            </p>
          )}

          {status && (awaitingAgents || failed || running) && (
            <div
              className={`bootstrap-banner ${failed ? "bootstrap-banner-blocked" : running ? "" : "bootstrap-banner-success"}`}
              role="status"
            >
              <p>{status.bootstrap.reason}</p>
              {job && <JobProgress job={job} />}
              {(canRunAgents || failed) && !running && (
                <div className="agent-run-box">
                  <label className="field">
                    <span>Export directory (optional if already stored)</span>
                    <div className="agent-run-row">
                      <input
                        type="text"
                        value={exportPath}
                        onChange={(event) => setExportPath(event.target.value)}
                        placeholder="/path/to/exports/1/v1"
                        disabled={busy}
                      />
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={busy}
                        onClick={() => runAgents.mutate()}
                      >
                        {runAgents.isPending ? "Starting…" : failed ? "Retry agents" : "Run inception agents"}
                      </button>
                    </div>
                  </label>
                </div>
              )}
            </div>
          )}

          {status && available && !status.empty && (
            <p className="bootstrap-banner" role="status">
              Extra files in this folder ({status.foreignEntries.slice(0, 4).join(", ")}
              {status.foreignEntries.length > 4 ? ", …" : ""}). Turn on force to execute anyway.
            </p>
          )}

          {available && (
            <form onSubmit={submitDryRun}>
              <div className="bootstrap-source-modes" role="tablist" aria-label="Export source">
                {(
                  [
                    ["catalog", "Export catalog"],
                    ["path", "Local path"],
                    ["url", "Package URL"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={sourceMode === mode}
                    className={`bootstrap-source-tab${sourceMode === mode ? " active" : ""}`}
                    disabled={busy}
                    onClick={() => setSourceMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {sourceMode === "catalog" && (
                <>
                  <label className="field">
                    <span>
                      Export catalog URL
                      <CatalogStatusInline
                        status={catalogStatus.data?.status ?? (catalogStatus.isError ? "offline" : null)}
                        pending={catalogStatus.isFetching && !catalogStatus.data}
                      />
                    </span>
                    <div className="agent-run-row">
                      <input
                        type="url"
                        value={catalogUrl}
                        onChange={(event) => setCatalogUrl(event.target.value)}
                        placeholder="http://127.0.0.1:8321"
                        disabled={!available || busy}
                        required
                      />
                      <button
                        className="btn btn-ghost"
                        type="button"
                        disabled={!available || busy || !catalogUrl.trim() || catalog.isFetching}
                        onClick={() => void loadCatalog()}
                      >
                        {catalog.isFetching ? "Loading…" : "Load exports"}
                      </button>
                    </div>
                  </label>
                  {catalogLoaded && catalog.isError && (
                    <p className="form-error">{catalog.error.message}</p>
                  )}
                  {catalogLoaded && !catalog.isFetching && catalog.data && (
                    <div className="export-catalog-panel">
                      <div className="export-filter-group" role="tablist" aria-label="Export filter">
                        {(
                          [
                            ["all", "All"],
                            ["new", "New"],
                            ["adopted", "Adopted"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="tab"
                            aria-selected={catalogFilter === value}
                            className={`export-filter-tab${catalogFilter === value ? " active" : ""}`}
                            disabled={busy}
                            onClick={() => setCatalogFilter(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {catalogExports.length === 0 ? (
                        <p className="export-catalog-empty">
                          {catalogFilter === "all"
                            ? "No exports in this catalog."
                            : `No ${catalogFilter} exports.`}
                        </p>
                      ) : (
                        <ul className="export-picker-list" role="listbox" aria-label="Bootstrap exports">
                          {catalogExports.map((item) => {
                            const selected = selectedExportId === item.id;
                            return (
                              <li key={item.id}>
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  className={`export-picker-item${selected ? " selected" : ""}`}
                                  disabled={!available || busy}
                                  onClick={() => setSelectedExportId(item.id)}
                                >
                                  <div className="export-picker-main">
                                    <strong>
                                      {item.inceptionName || `Inception #${item.inceptionId}`}
                                    </strong>
                                    <span className={`export-picker-status ${item.adoptionStatus}`}>
                                      {item.adoptionStatus === "adopted" ? "adopted" : "new"}
                                    </span>
                                  </div>
                                  {item.summary ? (
                                    <span className="export-picker-summary">{item.summary}</span>
                                  ) : null}
                                  <span className="export-picker-meta">
                                    v{item.version}
                                    {item.adoptedBy ? ` · ${item.adoptedBy}` : ""}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}

              {sourceMode === "path" && (
                <label className="field">
                  <span>Export directory</span>
                  <input
                    type="text"
                    value={exportPath}
                    onChange={(event) => setExportPath(event.target.value)}
                    placeholder="/path/to/exports/1/v1"
                    disabled={!available || busy}
                    required
                  />
                </label>
              )}

              {sourceMode === "url" && (
                <label className="field">
                  <span>Package URL</span>
                  <input
                    type="url"
                    value={exportUrl}
                    onChange={(event) => setExportUrl(event.target.value)}
                    placeholder="http://127.0.0.1:8321/api/exports/1/package"
                    disabled={!available || busy}
                    required
                  />
                </label>
              )}

              <label className="force-row">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                  disabled={!available || busy}
                />
                Force overwrite / allow non-empty folder
              </label>
              <div className="form-actions">
                <button className="btn btn-ghost" type="submit" disabled={!available || busy || !sourceReady()}>
                  {dryRun.isPending ? "Validating…" : "Dry run"}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!available || busy || !sourceReady()}
                  onClick={() => {
                    if (
                      confirm(
                        "Create git + Helix scaffolding, then run architect → scaffolder → validator?",
                      )
                    ) {
                      execute.mutate();
                    }
                  }}
                >
                  {execute.isPending ? "Starting…" : "Execute"}
                </button>
              </div>
            </form>
          )}
          {error && <p className="form-error">{error}</p>}
        </section>

        <section className="panel bootstrap-side-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Workspace</span>
              <h2>This folder</h2>
            </div>
          </div>
          {workspace.isPending && <p className="empty-row">Checking workspace…</p>}
          {status && (
            <>
              <div className="config-kv bootstrap-kv">
                <div className="kv-row"><span>Path</span><code>{status.cwd}</code></div>
                <div className="kv-row"><span>Git</span><code>{status.hasGit ? "yes" : "will create"}</code></div>
                <div className="kv-row"><span>Helix</span><code>{status.hasHelixConfig ? "scaffolded" : "will create"}</code></div>
                <div className="kv-row"><span>Empty</span><code>{status.empty ? "yes" : "no"}</code></div>
                <div className="kv-row"><span>State</span><code>{status.bootstrap.state}</code></div>
                <div className="kv-row"><span>Roles</span><code>{status.inception.roles.join(" → ")}</code></div>
              </div>
              <div className="bootstrap-specialists">
                <div className="manage-subheading">
                  <h3>Bootstrap specialists</h3>
                  <span>{specialists.length}</span>
                </div>
                <ul className="bootstrap-specialist-list">
                  {specialists.map((item) => (
                    <li key={item.name}>
                      <div className="resource-title">
                        <strong>{item.name}</strong>
                        <span className={`resource-source ${item.source}`}>{item.source.replace("_", " ")}</span>
                      </div>
                      <span>{item.description}</span>
                    </li>
                  ))}
                  {!specialists.length && (
                    <li className="inventory-empty">No bootstrap specialists resolved.</li>
                  )}
                </ul>
              </div>
              <div className="bootstrap-specialists">
                <div className="manage-subheading">
                  <h3>Bootstrap skills</h3>
                  <span>{skills.length}</span>
                </div>
                <p className="inventory-note">
                  Auto-loaded into architect / scaffolder / validator sessions. Edit via Manage.
                </p>
                <ul className="bootstrap-specialist-list">
                  {skills.map((item) => (
                    <li key={item.name}>
                      <div className="resource-title">
                        <strong>{item.name}</strong>
                        <span className={`resource-source ${item.source}`}>{item.source.replace("_", " ")}</span>
                      </div>
                      <span>{item.relativePath}</span>
                    </li>
                  ))}
                  {!skills.length && (
                    <li className="inventory-empty">No bootstrap skills resolved.</li>
                  )}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>

      {last && <BootstrapResultPanel result={last} />}
    </main>
  );
}

function JobProgress({ job }: { job: InceptionJob }) {
  return (
    <ul className="bootstrap-specialist-list job-progress-list" style={{ marginTop: 12 }}>
      {job.roles.map((role) => (
        <li key={role.role} className={`job-role job-role-${role.status}`}>
          <div className="resource-title">
            <span className="job-role-label">
              <span
                className={`job-dot ${role.status === "running" ? "job-pulse" : `job-dot-${role.status}`}`}
                aria-hidden="true"
              />
              <strong>{role.role}</strong>
            </span>
            <span className={`status-pill ${roleStatusTone(role.status)}`}>{role.status}</span>
          </div>
          {role.error && <span>{role.error}</span>}
        </li>
      ))}
    </ul>
  );
}

function roleStatusTone(status: string): string {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "pending":
    default:
      return "pending";
  }
}

function BootstrapResultPanel({ result }: { result: BootstrapResult }) {
  const preview = result.dryRun ? result : result.preview;
  const materialize = result.dryRun ? null : result.materialize;
  const job = result.dryRun ? null : "job" in result ? result.job : null;
  const previewSkills = preview.skills ?? [];
  const accepted = !result.dryRun && "accepted" in result && result.accepted;
  return (
    <section className="panel result-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">
            {result.dryRun ? "Dry run result" : accepted ? "Bootstrap started" : "Bootstrap result"}
          </span>
          <h2>{preview.pickup.name} · v{preview.pickup.version}</h2>
        </div>
        <StatusChip
          label={result.dryRun ? "preview" : accepted ? "running" : job?.status ?? "done"}
          tone={result.dryRun || accepted || job?.status === "running_agents" ? "running" : "done"}
        />
      </div>
      <div className="config-kv bootstrap-kv">
        <div className="kv-row"><span>Export</span><code>{preview.pickup.exportDir}</code></div>
        <div className="kv-row">
          <span>Brief</span>
          <code>{preview.pickup.brief.replace(/\s+/g, " ").trim().slice(0, 180) || "(empty)"}</code>
        </div>
        <div className="kv-row">
          <span>Documents</span>
          <code>{preview.pickup.documents} in manifest · {preview.pickup.documentsOnDisk} on disk</code>
        </div>
        <div className="kv-row"><span>Artifacts</span><code>{preview.pickup.artifacts}</code></div>
        <div className="kv-row"><span>Primer notes</span><code>{preview.pickup.primerNotes}</code></div>
        <div className="kv-row">
          <span>Skills</span>
          <code>
            {previewSkills.length
              ? previewSkills.map((item) => `${item.name} (${item.source.replace("_", " ")})`).join(", ")
              : "none"}
          </code>
        </div>
        {materialize && (
          <>
            <div className="kv-row"><span>Git</span><code>initialized</code></div>
            <div className="kv-row">
              <span>Wrote</span>
              <code>
                {materialize.documentsWritten} docs · {materialize.artifactsWritten} artifacts ·{" "}
                {materialize.primerNotesWritten} primer
              </code>
            </div>
            <div className="kv-row"><span>Target</span><code>{materialize.targetDir}</code></div>
          </>
        )}
      </div>
      {job && <JobProgress job={job} />}
      {!result.dryRun && job?.status === "completed" && (
        <p className="bootstrap-banner bootstrap-banner-success">
          Inception agents finished. PR Reviews is available — start a run when ready.
        </p>
      )}
      {!result.dryRun && accepted && (
        <p className="bootstrap-banner">
          Agents are running in the background. This page polls until they finish.
        </p>
      )}
    </section>
  );
}

function sortCatalogExports(items: BootstrapExportCatalogItem[]): BootstrapExportCatalogItem[] {
  return [...items].sort((a, b) => {
    if (a.adoptionStatus !== b.adoptionStatus) {
      return a.adoptionStatus === "available" ? -1 : 1;
    }
    return b.createdAt - a.createdAt || b.id - a.id;
  });
}

function CatalogStatusInline({
  status,
  pending,
}: {
  status: ExportCatalogStatus["status"] | null;
  pending?: boolean;
}) {
  const resolved = pending ? null : status;
  if (!resolved || resolved === "unconfigured") return null;
  return (
    <span className={`catalog-status-inline ${resolved}`} role="status" aria-live="polite">
      {" "}({resolved})
    </span>
  );
}

function StatusChip({ label, tone }: { label: string; tone: "idle" | "running" | "done" | "error" }) {
  return <span className={`status-pill ${tone === "idle" ? "" : tone}`}>{label}</span>;
}
