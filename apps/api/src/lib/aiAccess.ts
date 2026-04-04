import { config } from "../config.js";

export type StoredPlan = "free" | "ai";

export function normalizeStoredPlan(raw: unknown): StoredPlan {
  return raw === "ai" ? "ai" : "free";
}

/**
 * True when the user may call AI-tier API routes.
 * Pre-billing: while `ENABLE_STRIPE_CHECKOUT` is off, every signed-in user is AI-eligible (tidy,
 * similar notes, merge, organize). Rewrite still returns 503 until an OpenAI key is configured.
 * After checkout is enabled, use Firestore `plan: "ai"`, `DEV_GRANT_AI=1`, or
 * `AI_TIER_BYPASS_EMAILS`.
 */
export function userHasAiTier(email: string, storedPlan: StoredPlan): boolean {
  if (config.devGrantAi) return true;
  if (config.aiTierBypassEmails.includes(email.toLowerCase().trim())) return true;
  if (storedPlan === "ai") return true;
  if (!config.enableStripeCheckout) return true;
  return false;
}
