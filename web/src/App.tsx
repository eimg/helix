import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, timeAgo, timeOnly } from "./api";

type RunStatus = "running" | "done" | "escalated" | "error";

interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  source: "github" | "inline";
  startedAt: number;
  finishedAt?: number;
  labels: string[];
  eventCount: number;
  live: boolean;
}

interface RunEvent {
  ts: number;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
}

interface Run {
  id: string;
  issue: { title: string; body: string; labels: string[] };
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  events: RunEvent[];
  results: unknown[];
  finalDecision?: {
    kind: "run" | "done" | "escalate";
    reason?: string;
    deliverable?: string;
    specialists?: { specialist: string; task: string }[];
  };
  pullRequest?: { url: string; number: number };
  approvalStatus?: string;
  deliverableError?: string;
  implementationWorkspace?: { path: string; branch: string };
}

interface LogBlock {
  key: string;
  kind: "event" | "orchestrator" | "specialist";
  ts: number;
  title: string;
  status?: string;
  summary?: string;
  output?: string;
  task?: string;
  activities?: string[];
  tone?: string;
}

export function App() {
  const client = useQueryClient();
  const deepLink = new URLSearchParams(location.search).get("run");
  const [selectedId, setSelectedId] = useState<string | null>(deepLink);
  const [clearedId, setClearedId] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ["runs"],
    queryFn: () => api<RunSummary[]>("/runs?limit=50"),
    refetchInterval: (query) => query.state.data?.some((run) => run.live) ? 2_000 : false,
  });
  const selectedSummary = history.data?.find((run) => run.id === selectedId);
  const run = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => api<Run>(`/runs/${encodeURIComponent(selectedId!)}`),
    enabled: selectedId !== null,
    refetchInterval: selectedSummary?.live ? 2_000 : false,
  });
  const streamedEvents = useRunEvents(selectedId, selectedSummary?.live === true, run.data?.events);
  const create = useMutation({
    mutationFn: (payload: { title: string; body: string }) =>
      api<{ id: string }>("/runs", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: async ({ id }) => {
      setSelectedId(id);
      setClearedId(null);
      await client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async (_, id) => {
      if (selectedId === id) setSelectedId(null);
      await client.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  useEffect(() => {
    if (!selectedId && history.data) {
      const live = history.data.find((item) => item.live);
      if (live) setSelectedId(live.id);
    }
  }, [history.data, selectedId]);

  return (
    <div className="app-shell">
      <Header />
      <main className="workspace">
        <div className="top-grid">
          <RunForm mutation={create} />
          <HistoryPanel
            query={history}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setClearedId(null);
            }}
            onDelete={(summary) => {
              if (confirm(`Delete run "${summary.title}"? This cannot be undone.`)) remove.mutate(summary.id);
            }}
          />
        </div>
        <LogPanel
          run={clearedId === selectedId ? undefined : run.data}
          events={clearedId === selectedId ? [] : streamedEvents}
          loading={run.isPending && selectedId !== null}
          selectedId={selectedId}
          interrupted={run.data?.status === "running" && !selectedSummary?.live}
          onClear={() => selectedId && setClearedId(selectedId)}
        />
        {run.data && <ResultPanel run={run.data} />}
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">H</span>
        <div>
          <h1>Helix</h1>
          <p>Agent orchestration control plane</p>
        </div>
      </div>
      <nav className="site-nav" aria-label="Workspace">
        <a className="nav-link active" href="/react/">Run</a>
        <a className="nav-link" href="/reviews">PR Reviews</a>
        <a className="nav-link" href="/manage">Manage</a>
        <a className="nav-link" href="/config">Config</a>
      </nav>
      <span className="preview-badge">React preview</span>
    </header>
  );
}

function RunForm({
  mutation,
}: {
  mutation: ReturnType<typeof useMutation<{ id: string }, Error, { title: string; body: string }>>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    mutation.mutate({ title: title.trim(), body: body.trim() });
  };
  return (
    <section className="panel form-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">New workflow</span><h2>Start a run</h2></div>
        <StatusPill status={mutation.isPending ? "running" : mutation.isError ? "error" : "idle"} />
      </div>
      <form onSubmit={submit}>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="Fix the login bug" disabled={mutation.isPending} />
        </label>
        <label className="field">
          <span>Body</span>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={5} placeholder="Describe the task…" disabled={mutation.isPending} />
        </label>
        {mutation.isError && <p className="form-error">{mutation.error.message}</p>}
        <div className="form-actions">
          <button className="btn btn-primary" disabled={mutation.isPending || !title.trim()}>
            <Icon name="play" /> {mutation.isPending ? "Starting…" : "Run"}
          </button>
        </div>
      </form>
    </section>
  );
}

function HistoryPanel({
  query,
  selectedId,
  onSelect,
  onDelete,
}: {
  query: ReturnType<typeof useQuery<RunSummary[]>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (run: RunSummary) => void;
}) {
  return (
    <section className="panel history-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">Recent activity</span><h2>Run history</h2></div>
        <button className="btn btn-ghost btn-sm" onClick={() => query.refetch()}>
          <Icon name="refresh" /> Refresh
        </button>
      </div>
      <ul className="history-list">
        {query.data?.map((run) => {
          const interrupted = run.status === "running" && !run.live;
          const status = run.live ? "live" : interrupted ? "interrupted" : run.status;
          return (
            <li key={run.id}>
              <button className={`history-item ${selectedId === run.id ? "active" : ""}`} onClick={() => onSelect(run.id)}>
                <span className="history-main">
                  <strong>{run.title}</strong>
                  <span>{run.id.slice(0, 8)} · {timeAgo(run.startedAt)}</span>
                </span>
                <StatusPill status={status} />
              </button>
              {!run.live && (
                <button className="delete-button" aria-label={`Delete ${run.title}`} onClick={() => onDelete(run)}>
                  <Icon name="trash" />
                </button>
              )}
            </li>
          );
        })}
        {query.isPending && <li className="empty-row">Loading run history…</li>}
        {query.data && !query.data.length && <li className="empty-row">No runs yet.</li>}
        {query.isError && <li className="empty-row error-text">{query.error.message}</li>}
      </ul>
    </section>
  );
}

function LogPanel({
  run,
  events,
  loading,
  selectedId,
  interrupted,
  onClear,
}: {
  run?: Run;
  events: RunEvent[];
  loading: boolean;
  selectedId: string | null;
  interrupted: boolean;
  onClear: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => buildLog(events), [events]);
  useEffect(() => {
    if (run?.status === "running") bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [blocks.length, run?.status]);
  return (
    <section className="panel log-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{run ? `Run ${run.id.slice(0, 8)}` : "Execution"}</span>
          <h2>Live log</h2>
        </div>
        <div className="heading-actions">
          {run && <StatusPill status={interrupted ? "interrupted" : run.status} />}
          <button className="btn btn-ghost btn-sm" onClick={onClear} disabled={!run}><Icon name="clear" /> Clear</button>
        </div>
      </div>
      <div className="log">
        {loading && <p className="log-empty">Loading run…</p>}
        {!loading && !run && <p className="log-empty">{selectedId ? "Log cleared." : "Submit a task or select a run from history."}</p>}
        {blocks.map((block) => <LogEntry block={block} key={block.key} />)}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function LogEntry({ block }: { block: LogBlock }) {
  if (block.kind === "event") {
    return (
      <div className={`event-row ${block.tone || ""}`}>
        <time>{timeOnly(block.ts)}</time><span className="event-tag">{block.title}</span><span>{block.summary}</span>
      </div>
    );
  }
  return (
    <details className={`agent-block ${block.kind}`} open={block.status === "running"}>
      <summary>
        <time>{timeOnly(block.ts)}</time>
        <span className="agent-name">{block.kind === "orchestrator" ? "Orchestrator" : block.title}</span>
        <span className={`agent-status ${block.status || ""}`}>{block.status}</span>
      </summary>
      <div className="agent-body">
        {block.task && <p className="agent-task">{block.task}</p>}
        {block.activities?.map((activity, index) => <p className="activity" key={`${activity}-${index}`}>→ {activity}</p>)}
        {block.summary && <p className="agent-summary">{block.summary}</p>}
        {block.output && <pre>{block.output}</pre>}
      </div>
    </details>
  );
}

function ResultPanel({ run }: { run: Run }) {
  if (run.status === "running") return null;
  const elapsed = run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1_000)) : null;
  return (
    <section className="panel result-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">Outcome</span><h2>Result</h2></div>
        <span className="result-stat">{run.results.length} specialists · {elapsed ?? "?"}s</span>
      </div>
      {run.finalDecision?.kind === "done" && run.finalDecision.deliverable && (
        <ResultBlock title="Deliverable"><pre>{run.finalDecision.deliverable}</pre></ResultBlock>
      )}
      {run.finalDecision?.kind === "escalate" && (
        <ResultBlock title="Reason"><pre>{run.finalDecision.reason}</pre></ResultBlock>
      )}
      {run.pullRequest?.url && <a className="result-link" href={run.pullRequest.url} target="_blank" rel="noreferrer">Pull request #{run.pullRequest.number} ↗</a>}
      {run.deliverableError && <p className="error-text">{run.deliverableError}</p>}
      {run.implementationWorkspace && (
        <p className="workspace-note">Workspace retained at <code>{run.implementationWorkspace.path}</code> on <code>{run.implementationWorkspace.branch}</code>.</p>
      )}
    </section>
  );
}

function ResultBlock({ title, children }: { title: string; children: ReactNode }) {
  return <div className="result-block"><h3>{title}</h3>{children}</div>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}

function buildLog(events: RunEvent[]): LogBlock[] {
  const blocks: LogBlock[] = [];
  const agentBlocks = new Map<string, LogBlock>();
  for (const [index, event] of events.entries()) {
    const details = event.details ?? {};
    if (event.type === "issue_fetched") continue;
    if (event.type.startsWith("orchestrator_")) {
      const key = `orchestrator:${String(details.invocationId ?? details.iteration ?? index)}`;
      if (event.type === "orchestrator_started") {
        const block: LogBlock = { key, kind: "orchestrator", ts: event.ts, title: "Orchestrator", status: "running" };
        blocks.push(block);
        agentBlocks.set(key, block);
      } else {
        const block = agentBlocks.get(key);
        const current = block ?? [...agentBlocks.values()].reverse().find((item) => item.kind === "orchestrator");
        if (current && event.type === "orchestrator_output_delta") {
          current.output = `${current.output ?? ""}${String(details.delta ?? "")}`;
        } else if (current && event.type === "orchestrator_finished") {
          current.status = details.ok === false ? "failed" : "finished";
          current.output = String(details.output ?? details.error ?? "");
        } else if (current && event.type === "orchestrator_decided") {
          current.summary = decisionSummary(details.decision);
        } else if (event.type === "orchestrator_decided") {
          blocks.push({
            key: `${key}:decision`,
            kind: "orchestrator",
            ts: event.ts,
            title: "Orchestrator",
            status: decisionSummary(details.decision),
            summary: String(details.reason ?? event.summary),
          });
        }
      }
      continue;
    }
    if (event.type.startsWith("specialist_")) {
      const name = String(details.specialist ?? event.summary);
      const key = `specialist:${name}:${String(details.invocationId ?? index)}`;
      if (event.type === "specialist_started") {
        const block: LogBlock = {
          key,
          kind: "specialist",
          ts: event.ts,
          title: name,
          status: "running",
          task: String(details.task ?? ""),
          activities: [],
        };
        blocks.push(block);
        agentBlocks.set(key, block);
      } else {
        const direct = agentBlocks.get(key);
        const block = direct ?? [...agentBlocks.values()].reverse().find((item) => item.kind === "specialist" && item.title === name);
        if (block && event.type === "specialist_output_delta") {
          block.output = `${block.output ?? ""}${String(details.delta ?? "")}`;
        } else if (block && event.type === "specialist_activity") {
          const line = String(details.line ?? event.summary);
          if (!block.activities?.includes(line)) block.activities?.push(line);
        } else if (block && event.type === "specialist_finished") {
          block.status = details.ok === false ? "failed" : "finished";
          block.output = String(details.output ?? details.error ?? "");
        }
      }
      continue;
    }
    const mapping: Record<string, [string, string]> = {
      run_started: ["Run", "accent"],
      run_done: ["Done", "success"],
      run_escalated: ["Escalated", "warning"],
      run_error: ["Error", "danger"],
      gate_blocked: ["Gate blocked", "danger"],
    };
    const [title, tone] = mapping[event.type] ?? [event.type.replaceAll("_", " "), ""];
    blocks.push({ key: `${event.ts}:${event.type}:${index}`, kind: "event", ts: event.ts, title, summary: event.summary, tone });
  }
  return blocks;
}

function useRunEvents(
  runId: string | null,
  live: boolean,
  durableEvents: RunEvent[] | undefined,
): RunEvent[] {
  const client = useQueryClient();
  const [events, setEvents] = useState<RunEvent[]>(durableEvents ?? []);
  useEffect(() => {
    setEvents(durableEvents ?? []);
  }, [runId, durableEvents]);
  useEffect(() => {
    if (!runId || !live) return;
    const source = new EventSource(`/runs/${encodeURIComponent(runId)}/events`);
    const receive = (message: MessageEvent<string>) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return;
      }
      setEvents((current) => mergeStreamEvent(current, event));
      if (event.type === "run_done" || event.type === "run_escalated" || event.type === "run_error") {
        void client.invalidateQueries({ queryKey: ["run", runId] });
        void client.invalidateQueries({ queryKey: ["runs"] });
        source.close();
      }
    };
    source.onmessage = receive;
    source.addEventListener("live", receive as EventListener);
    return () => source.close();
  }, [client, live, runId]);
  return events;
}

function mergeStreamEvent(current: RunEvent[], incoming: RunEvent): RunEvent[] {
  const invocationId = incoming.details?.invocationId;
  const isDelta = incoming.type === "orchestrator_output_delta" || incoming.type === "specialist_output_delta";
  if (isDelta && typeof invocationId === "string") {
    const index = current.findIndex((event) =>
      event.type === incoming.type && event.details?.invocationId === invocationId
    );
    if (index >= 0) {
      const next = [...current];
      const previous = next[index];
      next[index] = {
        ...incoming,
        details: {
          ...incoming.details,
          delta: `${String(previous.details?.delta ?? "")}${String(incoming.details?.delta ?? "")}`,
        },
      };
      return next;
    }
  }
  const duplicate = current.some((event) =>
    event.ts === incoming.ts
    && event.type === incoming.type
    && event.summary === incoming.summary
    && event.details?.invocationId === invocationId
  );
  return duplicate ? current : [...current, incoming];
}

function decisionSummary(value: unknown): string {
  if (!value || typeof value !== "object") return "decided";
  const decision = value as { kind?: string; specialists?: { specialist: string }[] };
  return decision.kind === "run"
    ? `run ${(decision.specialists ?? []).map((item) => item.specialist).join(", ")}`
    : decision.kind ?? "decided";
}

type IconName = "clear" | "play" | "refresh" | "trash";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    clear: <><path d="M5 5l14 14M19 5 5 19" /></>,
    play: <path d="m8 5 11 7-11 7z" />,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.2 8.2A7 7 0 0 1 18.5 7L20 12M4 12l1.5 5a7 7 0 0 0 12.3-1.2" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
