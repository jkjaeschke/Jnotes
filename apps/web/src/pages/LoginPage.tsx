import { useEffect, useRef } from "react";
import type { User } from "../App.js";
import { apiSend } from "../api.js";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: {
            client_id: string;
            callback: (r: { credential: string }) => void;
          }) => void;
          renderButton: (el: HTMLElement, opts: object) => void;
        };
      };
    };
  }
}

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

type Props = {
  onAuthed: (user: User, idToken: string) => void;
};

export function LoginPage({ onAuthed }: Props) {
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!clientId) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      if (!window.google || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (res) => {
          const credential = res.credential;
          const out = await apiSend<{ user: User }>(
            "/api/auth/google",
            "POST",
            { idToken: credential }
          );
          onAuthed(out.user, credential);
        },
      });
      window.google.accounts.id.renderButton(btnRef.current, {
        theme: "outline",
        size: "large",
        text: "continue_with",
        width: 280,
      });
    };
    document.body.appendChild(script);
    return () => {
      script.remove();
    };
  }, [onAuthed]);

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 style={{ marginTop: 0 }}>FreeNotes</h1>
        <p className="muted">Sign in with Google to continue.</p>
        {!clientId && (
          <p className="muted">
            Set <code>VITE_GOOGLE_CLIENT_ID</code> in <code>apps/web/.env</code>.
          </p>
        )}
        <div ref={btnRef} style={{ marginTop: "1.5rem" }} />
      </div>
    </div>
  );
}
