import { config } from "../config.js";

export type StoredPlan = "free" | "ai";

export function normalizeStoredPlan(raw: unknown): StoredPlan {
  return raw === "ai" ? "ai" : "free";
}

/**
 * True when the user may call AI-tier API routes.
 * Pre-billing: if Stripe checkout is off but an OpenAI key is configured (env or Secret Manager),
 * all signed-in users are treated as AI-eligible. Once `ENABLE_STRIPE_CHECKOUT=1`, use Firestore
 * `plan: "ai"`, `DEV_GRANT_AI=1`, or `AI_TIER_BYPASS_EMAILS` instead.
 */
export function userHasAiTier(email: string, storedPlan: StoredPlan): boolean {
  if (config.devGrantAi) return true;
  if (config.aiTierBypassEmails.includes(email.toLowerCase().trim())) return true;
  if (storedPlan === "ai") return true;
  if (!config.enableStripeCheckout && config.openaiApiKey.length > 0) return true;
  return false;
}
