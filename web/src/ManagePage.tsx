import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ManageInventoryAgent, ManageInventorySkill, ManageSession } from "../../src/manage/types";
import { api } from "./api";

interface Workflow { steps: string[]; maxIterations?: number }

export function ManagePage() {
  const client = useQueryClient();
  const [steps, setSteps] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [force, setForce] = useState(false);
  const agents = useQuery({ queryKey: ["manage-agents"], queryFn: () => api<ManageInventoryAgent[]>("/manage/agents") });
  const skills = useQuery({ queryKey: ["manage-skills"], queryFn: () => api<ManageInventorySkill[]>("/manage/skills") });
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
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["manage-agents"] }); void client.invalidateQueries({ queryKey: ["manage-skills"] }); void client.invalidateQueries({ queryKey: ["manage-session", sessionId] }); },
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
  return <main className="workspace manage-workspace">
    <div className="manage-grid">
      <section className="panel manage-author">
        <div className="panel-heading"><div><span className="eyebrow">Resource authoring</span><h2>Manage agents & skills</h2></div><span className={`status-pill ${current?.status ?? (start.isPending ? "running" : "idle")}`}>{current?.status ?? (start.isPending ? "starting" : "idle")}</span></div>
        <form onSubmit={submit}><label className="field"><span>{sessionId ? "Follow-up instruction" : "Instruction"}</span><textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Create a verifier that runs eslint and tsc…" /></label><div className="form-actions"><button className="btn btn-primary" disabled={!prompt.trim() || start.isPending || followUp.isPending}>{sessionId ? "Send follow-up" : "Start session"}</button></div></form>
        <div className="manage-log">{current?.events.map((event, index) => <p key={`${event.ts}-${index}`}><span>{event.type.replaceAll("_", " ")}</span>{event.summary}</p>) ?? <p className="log-empty">Describe an agent or skill to create or edit.</p>}</div>
      </section>
      <section className="panel inventory-panel">
        <div className="panel-heading"><div><span className="eyebrow">Project resources</span><h2>Inventory</h2></div></div>
        <div className="inventory-grid"><div><h3>Agents</h3><ul>{agents.data?.map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.description || item.relativePath}</span></li>)}</ul></div><div><h3>Skills</h3><ul>{skills.data?.map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.relativePath}</span></li>)}</ul></div></div>
      </section>
    </div>
    <section className="panel workflow-panel">
      <div className="panel-heading"><div><span className="eyebrow">Default orchestration</span><h2>Workflow order</h2></div><button className="btn btn-primary" disabled={!steps.length || saveWorkflow.isPending} onClick={() => saveWorkflow.mutate()}>Save workflow</button></div>
      <div className="workflow-list">{steps.map((name, index) => <div className="workflow-row" key={`${name}-${index}`}><span>{index + 1}</span><strong>{name}</strong><div><button className="btn btn-ghost btn-sm" disabled={!index} onClick={() => move(steps, setSteps, index, -1)}>↑</button><button className="btn btn-ghost btn-sm" disabled={index === steps.length - 1} onClick={() => move(steps, setSteps, index, 1)}>↓</button><button className="btn btn-ghost btn-sm" onClick={() => setSteps(steps.filter((_, i) => i !== index))}>Remove</button></div></div>)}</div>
      <div className="workflow-add"><select onChange={(event) => { if (event.target.value && !steps.includes(event.target.value)) setSteps([...steps, event.target.value]); event.target.value = ""; }} defaultValue=""><option value="">Add agent…</option>{agents.data?.filter((item) => !steps.includes(item.name)).map((item) => <option key={item.name}>{item.name}</option>)}</select></div>
    </section>
    {current && (current.drafts.length > 0 || current.deletions.length > 0) && <section className="panel drafts-panel">
      <div className="panel-heading"><div><span className="eyebrow">Review before writing</span><h2>Proposed changes</h2></div><div className="heading-actions"><button className="btn btn-ghost" onClick={() => discard.mutate()}>Discard</button><button className="btn btn-primary" onClick={() => apply.mutate()}>Apply</button></div></div>
      {current.drafts.map((draft) => <details open className="draft" key={draft.relativePath}><summary>{draft.relativePath} <span className="status-pill">{draft.kind}</span></summary><pre>{draft.content}</pre></details>)}
      {current.deletions.map((item) => <p className="deletion" key={item.relativePath}>DELETE <code>{item.relativePath}</code></p>)}
      <label className="force-row"><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} /> Force overwrite existing files</label>
    </section>}
  </main>;
}

function move(steps: string[], setSteps: (value: string[]) => void, index: number, direction: -1 | 1) {
  const next = [...steps]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; setSteps(next);
}
