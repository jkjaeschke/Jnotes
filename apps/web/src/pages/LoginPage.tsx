import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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
          renderButton: (el: HTMLElement, opts: { width?: number } & Record<string, unknown>) => void;
          disableAutoSelect?: () => void;
        };
      };
    };
  }
}

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

/** Keep sign-in button within narrow viewports (fixed 280px overflows on small phones). */
function googleButtonWidthPx(): number {
  if (typeof window === "undefined") return 280;
  return Math.min(280, Math.max(220, window.innerWidth - 48));
}

type Props = {
  onAuthed: (user: User, idToken: string) => void;
};

let gsiInitialized = false;

export function LoginPage({ onAuthed }: Props) {
  const btnRef = useRef<HTMLDivElement>(null);
  const onAuthedRef = useRef(onAuthed);
  useLayoutEffect(() => {
    onAuthedRef.current = onAuthed;
  });

  const signOutFreeNotes = useCallback(async () => {
    try {
      await apiSend("/api/auth/logout", "POST");
    } catch {
      /* still reload to drop client state */
    }
    try {
      window.google?.accounts?.id?.disableAutoSelect?.();
    } catch {
      /* ignore */
    }
    window.location.reload();
  }, []);

  useEffect(() => {
    if (!clientId) return;

    const mountButton = () => {
      if (!window.google || !btnRef.current) return;
      if (!gsiInitialized) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (res) => {
            const credential = res.credential;
            const out = await apiSend<{ user: User }>(
              "/api/auth/google",
              "POST",
              { idToken: credential }
            );
            onAuthedRef.current(out.user, credential);
          },
        });
        gsiInitialized = true;
      }
      btnRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(btnRef.current, {
        theme: "outline",
        size: "large",
        text: "continue_with",
        width: googleButtonWidthPx(),
      });
    };

    const existing = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]'
    ) as HTMLScriptElement | null;

    if (existing) {
      if (window.google) mountButton();
      else existing.addEventListener("load", mountButton, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = mountButton;
    document.body.appendChild(script);
  }, [clientId]);

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
        <p className="muted login-session-hint">
          <button type="button" className="link-button" onClick={() => void signOutFreeNotes()}>
            Sign out of FreeNotes
          </button>{" "}
          to clear your session and try again.
        </p>
        <div ref={btnRef} className="login-google-slot" />
      </div>
    </div>
  );
}
