import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ManageInventoryAgent,
  ManageInventoryInceptionAgent,
  ManageInventoryPrAgent,
  ManageInventorySkill,
  ManageSession,
} from "../../src/manage/types";
import { api } from "./api";

interface Workflow { steps: string[]; maxIterations?: number }

export function ManagePage() {
  const client = useQueryClient();
  const [steps, setSteps] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [force, setForce] = useState(false);
  const agents = useQuery({ queryKey: ["manage-agents"], queryFn: () => api<ManageInventoryAgent[]>("/manage/agents") });
  const prAgents = useQuery({ queryKey: ["manage-pr-agents"], queryFn: () => api<ManageInventoryPrAgent[]>("/manage/pr-agents") });
  const bootstrapAgents = useQuery({
    queryKey: ["manage-inception-agents"],
    queryFn: () => api<ManageInventoryInceptionAgent[]>("/manage/inception-agents"),
  });
  const skills = useQuery({ queryKey: ["manage-skills"], queryFn: () => api<ManageInventorySkill[]>("/manage/skills") });
  const bootstrapSkills = useQuery({
    queryKey: ["manage-inception-skills"],
    queryFn: () => api<ManageInventorySkill[]>("/manage/inception-skills"),
  });
  const workflow = useQuery({ queryKey: ["manage-workflow"], queryFn: () => api<Workflow>("/manage/workflow") });
  useEffect(() => { if (workflow.data) setSteps(workflow.data.steps); }, [workflow.data]);
  const session = useQuery({
    queryKey: ["manage-session", sessionId],
    queryFn: () => api<ManageSession>(`/manage/sessions/${sessionId}`),
    enabled: sessionId !== null,
    refetchInterval: (query) => query.state.data?.status === "active" ? 1_500 : false,
  });
  useEffect(() => {
    if (!sessionId || session.data?.status !== "active") return;
    const source = new EventSource(`/manage/sessions/${sessionId}/events`);
    source.onmessage = () => {
      void client.invalidateQueries({ queryKey: ["manage-session", sessionId] });
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [client, sessionId, session.data?.status]);
  const start = useMutation({
    mutationFn: (text: string) => api<{ id: string }>("/manage/sessions", { method: "POST", body: JSON.stringify({ prompt: text }) }),
    onSuccess: ({ id }) => { setSessionId(id); setPrompt(""); },
  });
  const followUp = useMutation({
    mutationFn: (text: string) => api<ManageSession>(`/manage/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content: text }) }),
    onSuccess: () => { setPrompt(""); void client.invalidateQueries({ queryKey: ["manage-session", sessionId] }); },
  });
  const apply = useMutation({
    mutationFn: () => api<ManageSession>(`/manage/sessions/${sessionId}/apply`, { method: "POST", body: JSON.stringify({ force }) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["manage-agents"] });
      void client.invalidateQueries({ queryKey: ["manage-pr-agents"] });
      void client.invalidateQueries({ queryKey: ["manage-inception-agents"] });
      void client.invalidateQueries({ queryKey: ["manage-skills"] });
      void client.invalidateQueries({ queryKey: ["manage-inception-skills"] });
      void client.invalidateQueries({ queryKey: ["manage-session", sessionId] });
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["config-snapshot"] });
    },
  });
  const discard = useMutation({
    mutationFn: () => api<ManageSession>(`/manage/sessions/${sessionId}/discard`, { method: "POST" }),
    onSuccess: () => setSessionId(null),
  });
  const saveWorkflow = useMutation({
    mutationFn: () => api<Workflow>("/manage/workflow", { method: "PUT", body: JSON.stringify({ steps }) }),
    onSuccess: (data) => { setSteps(data.steps); void client.invalidateQueries({ queryKey: ["manage-workflow"] }); },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    if (sessionId) followUp.mutate(prompt.trim()); else start.mutate(prompt.trim());
  };
  const current = session.data;
  const availableAgents = agents.data?.filter((item) => !steps.includes(item.name)) ?? [];
  const workflowDirty = workflow.data ? !sameSteps(steps, workflow.data.steps) : false;

  return (
    <main className="workspace manage-workspace">
      <div className="manage-grid">
        <section className="panel manage-author">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Resource authoring</span>
              <h2>Manage agents & skills</h2>
              <p className="panel-description">
                Author workflow, PR review, and bootstrap specialists plus their skills. Apply writes under <code>.helix/</code>.
              </p>
            </div>
            <span aria-live="polite" className={`status-pill ${current?.status ?? (start.isPending ? "running" : "idle")}`}>
              {current?.status ?? (start.isPending ? "starting" : "idle")}
            </span>
          </div>
          <form onSubmit={submit}>
            <label className="field">
              <span>{sessionId ? "Follow-up instruction" : "Instruction"}</span>
              <textarea
                rows={5}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Update the bootstrap architect to require success criteria before scaffolding…"
                disabled={start.isPending || followUp.isPending}
              />
            </label>
            <div className="form-actions">
              <button className="btn btn-primary" disabled={!prompt.trim() || start.isPending || followUp.isPending}>
                {start.isPending || followUp.isPending ? "Sending…" : sessionId ? "Send follow-up" : "Start session"}
              </button>
            </div>
          </form>
          <div className="manage-activity">
            <div className="manage-subheading">
              <h3>Session activity</h3>
              {current && <span>{current.events.length} {current.events.length === 1 ? "event" : "events"}</span>}
            </div>
            <div className="manage-log">
              {current?.events.map((event, index) => (
                <p key={`${event.ts}-${index}`}>
                  <span>{event.type.replaceAll("_", " ")}</span>
                  {event.summary}
                </p>
              )) ?? <p className="log-empty">Describe a workflow, PR, or bootstrap agent/skill to create or edit.</p>}
            </div>
          </div>
        </section>

        <section className="panel inventory-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Project resources</span>
              <h2>Inventory</h2>
            </div>
          </div>
          <div className="inventory-grid">
            <div className="inventory-group">
              <h3>Workflow agents <span>{agents.data?.length ?? 0}</span></h3>
              <ul>
                {agents.data?.map((item) => (
                  <li key={item.name}>
                    <strong>{item.name}</strong>
                    <span>{item.description || item.relativePath}</span>
                  </li>
                ))}
                {agents.data && !agents.data.length && <li className="inventory-empty">No workflow agents found.</li>}
              </ul>
              {agents.isError && <p className="error-text">{agents.error.message}</p>}
            </div>

            <div className="inventory-group">
              <h3>Skills <span>{skills.data?.length ?? 0}</span></h3>
              <ul>
                {skills.data?.map((item) => (
                  <li key={item.name}>
                    <strong>{item.name}</strong>
                    <span>{item.relativePath}</span>
                  </li>
                ))}
                {skills.data && !skills.data.length && <li className="inventory-empty">No skills found.</li>}
              </ul>
              {skills.isError && <p className="error-text">{skills.error.message}</p>}
            </div>

            <div className="inventory-group inventory-lane">
              <h3>PR review agents <span>{prAgents.data?.length ?? 0}</span></h3>
              <p className="inventory-note">Fixed reviewer and verifier roles. Built-in fallbacks can be overridden by drafting <code>pr-agents/*.md</code>.</p>
              <ul className="lane-agent-list">
                {prAgents.data?.map((item) => (
                  <li key={item.name}>
                    <div className="resource-title">
                      <strong>{item.name}</strong>
                      <span className={`resource-source ${item.source}`}>{item.source.replace("_", " ")}</span>
                    </div>
                    <span>{item.description}</span>
                    <small>{item.relativePath}</small>
                  </li>
                ))}
                {prAgents.data && !prAgents.data.length && <li className="inventory-empty">No PR review agents resolved.</li>}
              </ul>
              {prAgents.isError && <p className="error-text">{prAgents.error.message}</p>}
            </div>

            <div className="inventory-group inventory-lane">
              <h3>Bootstrap agents <span>{bootstrapAgents.data?.length ?? 0}</span></h3>
              <p className="inventory-note">
                Fixed architect, scaffolder, and validator roles for empty-workspace bootstrap. Override via <code>inception-agents/*.md</code>.
              </p>
              <ul className="lane-agent-list">
                {bootstrapAgents.data?.map((item) => (
                  <li key={item.name}>
                    <div className="resource-title">
                      <strong>{item.name}</strong>
                      <span className={`resource-source ${item.source}`}>{item.source.replace("_", " ")}</span>
                    </div>
                    <span>{item.description}</span>
                    <small>{item.relativePath}</small>
                  </li>
                ))}
                {bootstrapAgents.data && !bootstrapAgents.data.length && (
                  <li className="inventory-empty">No bootstrap agents resolved.</li>
                )}
              </ul>
              {bootstrapAgents.isError && <p className="error-text">{bootstrapAgents.error.message}</p>}
            </div>

            <div className="inventory-group inventory-lane">
              <h3>Bootstrap skills <span>{bootstrapSkills.data?.length ?? 0}</span></h3>
              <p className="inventory-note">Skills under <code>inception-skills/</code> for bootstrap specialists — shown on Bootstrap and auto-loaded into inception sessions.</p>
              <ul className="lane-agent-list">
                {bootstrapSkills.data?.map((item) => (
                  <li key={item.name}>
                    <strong>{item.name}</strong>
                    <span>{item.relativePath}</span>
                  </li>
                ))}
                {bootstrapSkills.data && !bootstrapSkills.data.length && (
                  <li className="inventory-empty">No bootstrap skills found.</li>
                )}
              </ul>
              {bootstrapSkills.isError && <p className="error-text">{bootstrapSkills.error.message}</p>}
            </div>
          </div>
        </section>
      </div>

      <section className="panel workflow-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Default orchestration</span>
            <h2>Workflow order</h2>
            <p className="panel-description">Runs execute these agents from top to bottom. PR and bootstrap roles stay fixed.</p>
          </div>
          <button
            className={`btn ${workflowDirty ? "btn-primary" : "btn-ghost"}`}
            disabled={!steps.length || !workflowDirty || saveWorkflow.isPending}
            onClick={() => saveWorkflow.mutate()}
          >
            {saveWorkflow.isPending ? "Saving…" : workflowDirty ? "Save workflow" : "Saved"}
          </button>
        </div>
        <div className="workflow-list">
          {steps.map((name, index) => (
            <div className="workflow-row" key={`${name}-${index}`}>
              <span className="workflow-index">{index + 1}</span>
              <strong>{name}</strong>
              <div className="workflow-actions">
                <button aria-label={`Move ${name} up`} title="Move up" className="btn btn-ghost btn-sm workflow-move" disabled={!index} onClick={() => move(steps, setSteps, index, -1)}>↑</button>
                <button aria-label={`Move ${name} down`} title="Move down" className="btn btn-ghost btn-sm workflow-move" disabled={index === steps.length - 1} onClick={() => move(steps, setSteps, index, 1)}>↓</button>
                <button className="btn btn-ghost btn-sm workflow-remove" onClick={() => setSteps(steps.filter((_, i) => i !== index))}>Remove</button>
              </div>
            </div>
          ))}
        </div>
        <div className="workflow-add">
          <label>
            <span>Add workflow step</span>
            <select
              disabled={!availableAgents.length}
              onChange={(event) => {
                if (event.target.value && !steps.includes(event.target.value)) setSteps([...steps, event.target.value]);
                event.target.value = "";
              }}
              defaultValue=""
            >
              <option value="">{availableAgents.length ? "Choose an agent…" : "All agents are included"}</option>
              {availableAgents.map((item) => <option key={item.name}>{item.name}</option>)}
            </select>
          </label>
        </div>
        {saveWorkflow.isError && <p className="form-error">{saveWorkflow.error.message}</p>}
      </section>

      {current && (current.drafts.length > 0 || current.deletions.length > 0) && (
        <section className="panel drafts-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Review before writing</span>
              <h2>Proposed changes</h2>
            </div>
            <div className="heading-actions">
              <button className="btn btn-ghost" disabled={discard.isPending || apply.isPending} onClick={() => discard.mutate()}>Discard</button>
              <button className="btn btn-primary" disabled={discard.isPending || apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
          {current.drafts.map((draft) => (
            <details open className="draft" key={draft.relativePath}>
              <summary>
                {draft.relativePath} <span className="status-pill">{draft.kind}</span>
              </summary>
              <pre>{draft.content}</pre>
            </details>
          ))}
          {current.deletions.map((item) => (
            <p className="deletion" key={item.relativePath}>
              <strong>Delete</strong>
              <code>{item.relativePath}</code>
            </p>
          ))}
          <label className="force-row">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
            Force overwrite existing files
          </label>
          {(apply.isError || discard.isError) && (
            <p className="form-error">{apply.error?.message ?? discard.error?.message}</p>
          )}
        </section>
      )}
    </main>
  );
}

function move(steps: string[], setSteps: (value: string[]) => void, index: number, direction: -1 | 1) {
  const next = [...steps];
  [next[index], next[index + direction]] = [next[index + direction], next[index]];
  setSteps(next);
}

function sameSteps(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((step, index) => step === right[index]);
}
