import { useCallback, useEffect, useRef, useState } from "react";
import { apiSend } from "../api.js";

type Props = {
  open: boolean;
  onClose: () => void;
  googleToken: string | null;
};

export function FeedbackModal({ open, onClose, googleToken }: Props) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const reset = useCallback(() => {
    setMessage("");
    setErr(null);
    setDone(false);
    setSending(false);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    const t = window.setTimeout(() => textareaRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const submit = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setErr(null);
    setSending(true);
    try {
      await apiSend<{ ok: boolean }>("/api/feedback", "POST", { message: trimmed }, googleToken);
      setDone(true);
      setMessage("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setSending(false);
    }
  }, [message, sending, googleToken]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="feedback-modal-title" style={{ marginTop: 0, marginBottom: "0.5rem" }}>
          Send feedback
        </h2>
        <p className="muted" style={{ marginTop: 0, marginBottom: "0.75rem", fontSize: "0.875rem" }}>
          Bugs, ideas, or rough edges — your message is tied to your signed-in account so we can follow up
          if needed.
        </p>
        {done ? (
          <>
            <p style={{ margin: "0.75rem 0" }}>Thanks — we received your feedback.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="feedback-message" className="sr-only">
              Your feedback
            </label>
            <textarea
              ref={textareaRef}
              id="feedback-message"
              className="input feedback-modal-textarea"
              rows={6}
              placeholder="What happened? What would you like to see?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={sending}
              maxLength={8000}
            />
            {err && (
              <p style={{ color: "var(--danger)", margin: "0.5rem 0 0", fontSize: "0.875rem" }} role="alert">
                {err}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={sending || !message.trim()}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
