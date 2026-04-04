import { config } from "../config.js";

export type StoredPlan = "free" | "ai";

export function normalizeStoredPlan(raw: unknown): StoredPlan {
  return raw === "ai" ? "ai" : "free";
}

/** True when the user may call AI-tier API routes (stored plan, dev grant, or email bypass). */
export function userHasAiTier(email: string, storedPlan: StoredPlan): boolean {
  if (config.devGrantAi) return true;
  if (config.aiTierBypassEmails.includes(email.toLowerCase().trim())) return true;
  return storedPlan === "ai";
}
