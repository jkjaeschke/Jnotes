import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiUpload } from "../api.js";

type Notebook = { id: string; name: string };

type Job = {
  id: string;
  status: string;
  notebookId: string | null;
  fileName: string | null;
  notesCreated: number;
  notesSkipped: number;
  error: string | null;
};

type Props = {
  googleToken: string | null;
  onDone: () => void;
};

export function ImportPage({ googleToken, onDone }: Props) {
  const navigate = useNavigate();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookId, setNotebookId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<{ notebooks: Notebook[] }>("/api/notebooks", googleToken).then((r) =>
      setNotebooks(r.notebooks)
    );
  }, [googleToken]);

  const pollJob = useCallback(
    async (id: string) => {
      try {
        for (let i = 0; i < 120; i++) {
          const r = await apiGet<{ job: Job }>(`/api/imports/${id}`, googleToken);
          const j = r.job;
          setStatus(`${j.status} — created ${j.notesCreated}, skipped ${j.notesSkipped}`);
          if (j.status === "completed" || j.status === "failed") {
            if (j.error) setErr(j.error);
            onDone();
            if (j.status === "completed" && j.notebookId) {
              navigate(`/?notebook=${encodeURIComponent(j.notebookId)}`);
            }
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        setErr("Import still running; refresh jobs from server.");
      } catch (e) {
        setErr(String(e));
      }
    },
    [googleToken, onDone, navigate]
  );

  const onFile = useCallback(
    async (f: File | null) => {
      if (!f) return;
      setErr(null);
      setStatus("Uploading…");
      const fd = new FormData();
      if (notebookId) {
        fd.append("notebookId", notebookId);
      }
      fd.append("file", f);
      try {
        const r = (await apiUpload("/api/imports", fd, googleToken)) as { job: Job };
        setStatus(`Job ${r.job.id} queued`);
        void pollJob(r.job.id);
      } catch (e) {
        setErr(String(e));
        setStatus("");
      }
    },
    [googleToken, notebookId, pollJob]
  );

  return (
    <div style={{ padding: "1rem", maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>Import Evernote (.enex)</h1>
      <p className="muted">
        Export from Evernote as ENEX. Leave notebook empty to auto-create one from the file name.
      </p>
      <label className="muted" style={{ display: "block", marginBottom: "0.35rem" }}>
        Target notebook (optional)
      </label>
      <select
        className="input"
        value={notebookId}
        onChange={(e) => setNotebookId(e.target.value)}
        style={{ marginBottom: "1rem" }}
      >
        <option value="">— Auto-create from file —</option>
        {notebooks.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name}
          </option>
        ))}
      </select>
      <div>
        <input
          type="file"
          accept=".enex,application/xml,text/xml"
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
      </div>
      {status && <p className="import-status">{status}</p>}
      {err && (
        <p style={{ color: "var(--danger)" }} role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
