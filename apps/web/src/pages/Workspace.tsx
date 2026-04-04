import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import type { User } from "../App.js";
import { apiSend } from "../api.js";
import { FeedbackModal } from "../components/FeedbackModal.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { WorkspaceOutletContext } from "../workspaceOutletContext.js";

const NAV_COLLAPSED_KEY = "freenotes-nav-collapsed";

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

function IconFeedback({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
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
  const isMobile = useMediaQuery("(max-width: 960px)");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
  });

  useEffect(() => {
    window.localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? "1" : "0");
  }, [navCollapsed]);

  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (isMobile) setNavCollapsed(false);
  }, [isMobile]);

  const logout = useCallback(async () => {
    await apiSend("/api/auth/logout", "POST", undefined, googleToken);
    onLogout();
    navigate("/login");
  }, [googleToken, navigate, onLogout]);

  const navLink = ({ isActive }: { isActive: boolean }) =>
    isActive ? "sidebar-nav-link active" : "sidebar-nav-link";

  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  const sidebarInner = (
    <>
      {!isMobile && (
        <div className="sidebar-panel-collapse">
          {navCollapsed ? (
            <button
              type="button"
              className="panel-collapse-toggle"
              onClick={() => setNavCollapsed(false)}
              aria-label="Expand menu"
              title="Expand menu"
            >
              »
            </button>
          ) : (
            <button
              type="button"
              className="panel-collapse-toggle"
              onClick={() => setNavCollapsed(true)}
              aria-label="Collapse menu"
              title="Collapse menu"
            >
              «
            </button>
          )}
        </div>
      )}
      <div className="sidebar-brand">
        <div className="sidebar-brand-title">Notes</div>
        <div className="sidebar-email">{user.email}</div>
        <button type="button" className="sidebar-signout" onClick={() => void logout()}>
          <IconSignOut />
          <span className="sidebar-nav-label">Sign out</span>
        </button>
      </div>
      <nav className="sidebar-nav">
        <NavLink to="/" end className={navLink} onClick={closeMobileNav}>
          <IconNotes />
          <span className="sidebar-nav-label">Notes</span>
        </NavLink>
        <NavLink to="/search" className={navLink} onClick={closeMobileNav}>
          <IconSearch />
          <span className="sidebar-nav-label">Search</span>
        </NavLink>
        <NavLink to="/import" className={navLink} onClick={closeMobileNav}>
          <IconImport />
          <span className="sidebar-nav-label">Import .enex</span>
        </NavLink>
        <button
          type="button"
          className="sidebar-nav-link"
          onClick={() => {
            setFeedbackOpen(true);
            closeMobileNav();
          }}
        >
          <IconFeedback />
          <span className="sidebar-nav-label">Feedback</span>
        </button>
      </nav>
    </>
  );

  return (
    <WorkspaceOutletContext.Provider value={{ isMobile, openMobileNav }}>
      <div className={`app-shell${navCollapsed && !isMobile ? " nav-collapsed" : ""}`}>
        {isMobile && mobileNavOpen && (
          <button
            type="button"
            className="sidebar-drawer-backdrop"
            aria-label="Close menu"
            onClick={closeMobileNav}
          />
        )}
        <aside
          className={`sidebar${isMobile ? " sidebar-mobile" : ""}${isMobile && mobileNavOpen ? " sidebar-mobile-open" : ""}`}
          aria-hidden={isMobile ? !mobileNavOpen : undefined}
        >
          {sidebarInner}
        </aside>

        {isMobile && (
          <header className="mobile-app-bar">
            <button type="button" className="mobile-app-bar-menu" onClick={openMobileNav} aria-label="Open menu">
              <span className="mobile-app-bar-icon" aria-hidden>
                ☰
              </span>
            </button>
            <span className="mobile-app-bar-title">FreeNotes</span>
          </header>
        )}

        <div className="app-main">
          <Outlet />
        </div>

        <FeedbackModal
          open={feedbackOpen}
          onClose={() => setFeedbackOpen(false)}
          googleToken={googleToken}
        />
      </div>
    </WorkspaceOutletContext.Provider>
  );
}
