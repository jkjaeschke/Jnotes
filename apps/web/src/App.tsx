import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { apiGetOptional } from "./api.js";
import { LoginPage } from "./pages/LoginPage.js";
import { Workspace } from "./pages/Workspace.js";
import { MainNotes } from "./pages/MainNotes.js";
import { SearchPage } from "./pages/SearchPage.js";
import { ImportPage } from "./pages/ImportPage.js";

export type User = {
  id: string;
  email: string;
  plan: "free" | "ai";
  aiTierActive: boolean;
};

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [nbKey, setNbKey] = useState(0);

  const refreshMe = useCallback(async (token?: string | null) => {
    try {
      const r = await apiGetOptional<{ user: User }>("/api/me", token ?? googleToken);
      setUser(r?.user ?? null);
    } catch {
      setUser(null);
    }
  }, [googleToken]);

  useEffect(() => {
    void refreshMe(null);
  }, [refreshMe]);

  if (user === undefined) {
    return (
      <div className="login-page muted" aria-busy="true">
        Loading…
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          user ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage
              onAuthed={(u, idToken) => {
                setUser(u);
                setGoogleToken(idToken);
                void refreshMe(idToken);
              }}
            />
          )
        }
      />
      {user ? (
        <Route
          path="/"
          element={
            <Workspace
              user={user}
              googleToken={googleToken}
              onLogout={() => {
                setUser(null);
                setGoogleToken(null);
              }}
            />
          }
        >
          <Route
            index
            element={
              <MainNotes
                user={user}
                googleToken={googleToken}
                refreshKey={nbKey}
                onNotebooksChanged={() => setNbKey((k) => k + 1)}
              />
            }
          />
          <Route path="search" element={<SearchPage googleToken={googleToken} />} />
          <Route
            path="import"
            element={<ImportPage googleToken={googleToken} onDone={() => setNbKey((k) => k + 1)} />}
          />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/login" replace />} />
      )}
    </Routes>
  );
}
