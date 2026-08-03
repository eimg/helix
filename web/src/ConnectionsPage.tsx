import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

type SteeringIntegrationStatus = {
  configured: boolean;
  url: string;
  source: "stored" | "environment" | "unconfigured";
  status: "online" | "offline" | "unconfigured";
  detail: string;
  checkedAt: string;
  credentialConfigured: boolean;
  credentialWillBeSent: boolean;
  startupConfigured: boolean;
};

export function ConnectionsPage({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: ["steering-integration"],
    queryFn: () => api<SteeringIntegrationStatus>("/api/integrations/steering"),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const [url, setUrl] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (connection.data) setUrl(connection.data.url);
  }, [connection.data?.url]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2_800);
  };

  const save = useMutation({
    mutationFn: (nextUrl: string | null) => api<SteeringIntegrationStatus>("/api/integrations/steering", {
      method: "PATCH",
      body: JSON.stringify({ url: nextUrl }),
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(["steering-integration"], result);
      setUrl(result.url);
      showToast(result.configured ? "Steering connection saved" : "Steering notifications disabled");
    },
    onError: (error: Error) => showToast(error.message),
  });

  const test = useMutation({
    mutationFn: () => api<SteeringIntegrationStatus>("/api/integrations/steering/test", { method: "POST" }),
    onSuccess: (result) => {
      queryClient.setQueryData(["steering-integration"], result);
      showToast(result.status === "online" ? "Steering is online" : result.detail);
    },
    onError: (error: Error) => showToast(error.message),
  });

  const current = connection.data;
  const changed = current !== undefined && url.trim().replace(/\/$/, "") !== current.url.replace(/\/$/, "");

  return (
    <main className="workspace config-workspace">
      <div className="page-title">
        <div>
          <span className="eyebrow">Local integrations</span>
          <h2>Connections</h2>
          <p>Optional Acme Steering integration for paused or interrupted run recovery.</p>
        </div>
      </div>

      <section className="panel connection-card">
        <div className="connection-heading">
          <div>
            <p className="eyebrow">Workflow steering</p>
            <h3>
              Acme Steering
              <span className={`connection-status ${current?.status ?? "pending"}`}>
                {connection.isLoading ? "checking" : current?.status ?? "unknown"}
              </span>
            </h3>
            <p className="connection-note">
              Helix publishes pause and interrupt lifecycle events and receives narrow recovery decisions through this connection.
            </p>
          </div>
        </div>
        {connection.isError ? (
          <p className="error-text">{connection.error.message}</p>
        ) : (
          <div className="connection-stack">
            <label className="field">
              <span>Steering URL</span>
              <input
                value={url}
                readOnly={!canWrite}
                placeholder="http://127.0.0.1:8323"
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
              />
            </label>
            <p className="connection-detail">{current?.detail ?? "Checking the connection…"}</p>
            {current?.source === "environment" && (
              <p className="hint">Provided by startup configuration. Saving here creates a Helix-local override.</p>
            )}
            {current?.credentialConfigured && !current.credentialWillBeSent && current.configured && (
              <p className="connection-warning">A service credential exists, but it will not be sent until this origin is trusted by the server configuration.</p>
            )}
            <p className="hint">Credentials remain server-side and cannot be viewed or changed here.</p>
            <div className="connection-actions">
              {canWrite && current?.source === "stored" && current.startupConfigured && (
                <button className="btn btn-ghost" type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>
                  Use startup setting
                </button>
              )}
              {canWrite && current?.configured && (
                <button className="btn btn-ghost" type="button" disabled={save.isPending} onClick={() => save.mutate("")}>
                  Disable
                </button>
              )}
              <button className="btn" type="button" disabled={!current?.configured || test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? "Testing…" : "Test connection"}
              </button>
              {canWrite && (
                <button className="btn btn-primary" type="button" disabled={!changed || save.isPending} onClick={() => save.mutate(url)}>
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              )}
            </div>
          </div>
        )}
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
