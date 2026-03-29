function splitEmails(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  /** GCP project ID for Firestore / Storage (defaults to ADC project). */
  gcpProjectId: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  allowlistEmails: splitEmails(process.env.ALLOWLIST_EMAILS),
  gcsBucket: process.env.GCS_BUCKET ?? "",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
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
