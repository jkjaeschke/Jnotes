import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiSend, apiUpload } from "../api.js";

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

type PresignResponse =
  | { mode: "multipart" }
  | {
      mode: "direct";
      jobId: string;
      fileName: string;
      uploadUrl: string;
      contentType: string;
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
      setStatus("Preparing upload…");
      try {
        const presign = await apiSend<PresignResponse>(
          "/api/imports/presign",
          "POST",
          { fileName: f.name },
          googleToken
        );

        let jobId: string;

        if (presign.mode === "multipart") {
          setStatus("Uploading…");
          const fd = new FormData();
          if (notebookId) {
            fd.append("notebookId", notebookId);
          }
          fd.append("file", f);
          const r = (await apiUpload("/api/imports", fd, googleToken)) as { job: Job };
          jobId = r.job.id;
        } else {
          setStatus("Uploading to storage…");
          const putRes = await fetch(presign.uploadUrl, {
            method: "PUT",
            body: f,
            headers: { "Content-Type": presign.contentType },
          });
          if (!putRes.ok) {
            const hint =
              putRes.status === 0
                ? " (blocked — check GCS bucket CORS allows your site; see infra/gcs-cors.json)"
                : "";
            throw new Error(`Direct upload failed (${putRes.status})${hint}`);
          }
          setStatus("Starting import…");
          const r = await apiSend<{ job: Job }>(
            "/api/imports/commit",
            "POST",
            {
              jobId: presign.jobId,
              fileName: presign.fileName,
              notebookId: notebookId || null,
            },
            googleToken
          );
          jobId = r.job.id;
        }

        setStatus(`Job ${jobId} queued`);
        void pollJob(jobId);
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
