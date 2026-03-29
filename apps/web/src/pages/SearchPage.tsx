import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api.js";

type Hit = {
  note: {
    id: string;
    notebookId: string;
    title: string;
  };
  headline: string | null;
};

type Props = { googleToken: string | null };

export function SearchPage({ googleToken }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const run = useCallback(async () => {
    if (!q.trim()) return;
    setErr(null);
    try {
      const r = await apiGet<{ hits: Hit[] }>(
        `/api/search?q=${encodeURIComponent(q.trim())}`,
        googleToken
      );
      setHits(r.hits);
    } catch (e) {
      setErr(String(e));
    }
  }, [q, googleToken]);

  return (
    <div style={{ padding: "1rem", maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>Search</h1>
      <div className="toolbar" style={{ marginBottom: "1rem" }}>
        <input
          className="input"
          placeholder="Search notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <button type="button" className="btn btn-primary" onClick={() => void run()}>
          Search
        </button>
      </div>
      {err && (
        <p style={{ color: "var(--danger)" }} role="alert">
          {err}
        </p>
      )}
      {hits.map((h) => (
        <div key={h.note.id} className="search-hit">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontWeight: 600, marginBottom: "0.35rem" }}
            onClick={() => navigate(`/?notebook=${h.note.notebookId}&note=${h.note.id}`)}
          >
            {h.note.title || "Untitled"}
          </button>
          {h.headline && (
            <div
              className="muted"
              dangerouslySetInnerHTML={{ __html: h.headline }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
