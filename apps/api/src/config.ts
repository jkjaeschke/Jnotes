function splitEmails(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

const DEFAULT_DEV_ORIGIN = "http://localhost:5173";

/** Origins allowed for CORS + browser credentialed requests. Must match the SPA’s window origin exactly. */
export function corsAllowedOrigins(): string[] {
  const multi = (process.env.FRONTEND_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const single = (process.env.FRONTEND_ORIGIN ?? "").trim();
  const merged = single ? [single, ...multi.filter((o) => o !== single)] : multi;
  return merged.length ? merged : [DEFAULT_DEV_ORIGIN];
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  /** GCP project ID for Firestore / Storage (defaults to ADC project). */
  gcpProjectId: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  allowlistEmails: splitEmails(process.env.ALLOWLIST_EMAILS),
  /** Comma-separated emails that receive AI tier without `plan: "ai"` in Firestore (dev/testing). */
  aiTierBypassEmails: splitEmails(process.env.AI_TIER_BYPASS_EMAILS),
  /**
   * When true, all authenticated users pass AI tier checks.
   * In development, defaults on so local play works without Firestore edits; set `DEV_GRANT_AI=0` to test free tier.
   * In production, only when `DEV_GRANT_AI=1`.
   */
  devGrantAi:
    process.env.DEV_GRANT_AI === "1" ||
    ((process.env.NODE_ENV ?? "development") === "development" &&
      process.env.DEV_GRANT_AI !== "0"),
  gcsBucket: process.env.GCS_BUCKET ?? "",
  /** First allowed origin (legacy); prefer `corsAllowedOrigins()` for CORS. */
  frontendOrigin: (process.env.FRONTEND_ORIGIN ?? "").trim() || DEFAULT_DEV_ORIGIN,
  staticDir: process.env.STATIC_DIR ?? "",
  localDataDir: process.env.LOCAL_DATA_DIR ?? "./data",
  nodeEnv: process.env.NODE_ENV ?? "development",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-change-me-in-production",
  /** Max OpenAI-style chat completions per user per calendar month (YYYY-MM). */
  aiRewriteMonthlyCap: Math.max(
    1,
    Number(process.env.AI_REWRITE_MONTHLY_CAP) || 50
  ),
  /** Plain env, or filled at startup from Secret Manager when `OPENAI_API_KEY_SECRET` is set. */
  openaiApiKey: (process.env.OPENAI_API_KEY ?? "").trim(),
  openaiApiBase: (process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  openaiModel: (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim(),
  stripeSecretKey: (process.env.STRIPE_SECRET_KEY ?? "").trim(),
  stripeWebhookSecret: (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim(),
  stripePriceIdAi: (process.env.STRIPE_PRICE_ID_AI ?? "").trim(),
  /** When `1`, registers `/api/billing/checkout` and `/api/billing/webhook`. Off by default so you can try AI without Stripe. */
  enableStripeCheckout: process.env.ENABLE_STRIPE_CHECKOUT === "1",
};

export function isEmailAllowed(email: string): boolean {
  const list = config.allowlistEmails;
  if (list.length === 0) return true;
  return list.includes(email.toLowerCase());
}
