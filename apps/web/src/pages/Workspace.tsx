import { useCallback } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import type { User } from "../App.js";
import { apiSend } from "../api.js";

function IconNotes({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconSearch({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconImport({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSignOut({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 17H5V7h5M14 7l4 5-4 5M19 12H9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Props = {
  user: User;
  googleToken: string | null;
  onLogout: () => void;
};

export function Workspace({ user, googleToken, onLogout }: Props) {
  const navigate = useNavigate();

  const logout = useCallback(async () => {
    await apiSend("/api/auth/logout", "POST", undefined, googleToken);
    onLogout();
    navigate("/login");
  }, [googleToken, navigate, onLogout]);

  const navLink = ({ isActive }: { isActive: boolean }) =>
    isActive ? "sidebar-nav-link active" : "sidebar-nav-link";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-title">Notes</div>
          <div className="sidebar-email">{user.email}</div>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/" end className={navLink}>
            <IconNotes />
            Notes
          </NavLink>
          <NavLink to="/search" className={navLink}>
            <IconSearch />
            Search
          </NavLink>
          <NavLink to="/import" className={navLink}>
            <IconImport />
            Import .enex
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
            <IconSignOut />
            Sign out
          </button>
        </div>
      </aside>
      <div className="app-main">
        <Outlet />
      </div>
    </div>
  );
}
