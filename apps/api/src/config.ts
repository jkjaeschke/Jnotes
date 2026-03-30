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
  gcsBucket: process.env.GCS_BUCKET ?? "",
  /** First allowed origin (legacy); prefer `corsAllowedOrigins()` for CORS. */
  frontendOrigin: (process.env.FRONTEND_ORIGIN ?? "").trim() || DEFAULT_DEV_ORIGIN,
  staticDir: process.env.STATIC_DIR ?? "",
  localDataDir: process.env.LOCAL_DATA_DIR ?? "./data",
  nodeEnv: process.env.NODE_ENV ?? "development",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-change-me-in-production",
};

export function isEmailAllowed(email: string): boolean {
  const list = config.allowlistEmails;
  if (list.length === 0) return true;
  return list.includes(email.toLowerCase());
}
