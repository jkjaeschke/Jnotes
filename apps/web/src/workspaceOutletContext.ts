import { createContext, useContext } from "react";

export type WorkspaceOutletContextValue = {
  isMobile: boolean;
  openMobileNav: () => void;
};

export const WorkspaceOutletContext = createContext<WorkspaceOutletContextValue | null>(null);

export function useWorkspaceOutlet(): WorkspaceOutletContextValue {
  const v = useContext(WorkspaceOutletContext);
  if (!v) {
    throw new Error("useWorkspaceOutlet must be used inside Workspace");
  }
  return v;
}
