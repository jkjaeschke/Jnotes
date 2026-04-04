import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { GoogleAuth } from "google-auth-library";
import { config } from "../config.js";

let client: SecretManagerServiceClient | null = null;

function smClient(): SecretManagerServiceClient {
  if (!client) client = new SecretManagerServiceClient();
  return client;
}

async function resolveGcpProjectId(): Promise<string> {
  const fromEnv =
    config.gcpProjectId.trim() ||
    (process.env.GOOGLE_CLOUD_PROJECT ?? "").trim() ||
    (process.env.GCP_PROJECT ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const auth = new GoogleAuth();
    const id = await auth.getProjectId();
    return id ?? "";
  } catch {
    return "";
  }
}

/**
 * Accepts:
 * - Short id: `my-openai-key` → `projects/{project}/secrets/my-openai-key/versions/latest`
 * - Version omitted: `projects/p/secrets/name` → `.../versions/latest`
 * - Full: `projects/p/secrets/name/versions/3`
 */
export function expandSecretVersionName(ref: string, projectId: string): string {
  const t = ref.trim();
  if (!t) throw new Error("Empty secret reference");
  if (t.startsWith("projects/")) {
    if (t.includes("/versions/")) return t;
    return `${t.replace(/\/$/, "")}/versions/latest`;
  }
  return `projects/${projectId}/secrets/${t}/versions/latest`;
}

export async function accessSecretVersion(ref: string): Promise<string> {
  const projectId = await resolveGcpProjectId();
  if (!projectId) {
    throw new Error(
      "Set GOOGLE_CLOUD_PROJECT (or GCP_PROJECT) to resolve Secret Manager secret names, or use a full projects/.../secrets/.../versions/... resource."
    );
  }
  const name = expandSecretVersionName(ref, projectId);
  const [version] = await smClient().accessSecretVersion({ name });
  const data = version.payload?.data;
  if (data == null) throw new Error(`Secret has no payload: ${name}`);
  return Buffer.from(data as Uint8Array).toString("utf8").trim();
}

/**
 * Fills `config` from Secret Manager when the env value is unset and `*_SECRET` points at a secret.
 * Plain env vars always win (local `.env`).
 */
export async function hydrateSecretsFromGCP(): Promise<void> {
  const openaiRef = (process.env.OPENAI_API_KEY_SECRET ?? "").trim();
  if (!config.openaiApiKey && openaiRef) {
    config.openaiApiKey = await accessSecretVersion(openaiRef);
  }

  if (config.enableStripeCheckout) {
    const stripeKeyRef = (process.env.STRIPE_SECRET_KEY_SECRET ?? "").trim();
    if (!config.stripeSecretKey && stripeKeyRef) {
      config.stripeSecretKey = await accessSecretVersion(stripeKeyRef);
    }
    const stripeWhRef = (process.env.STRIPE_WEBHOOK_SECRET_SECRET ?? "").trim();
    if (!config.stripeWebhookSecret && stripeWhRef) {
      config.stripeWebhookSecret = await accessSecretVersion(stripeWhRef);
    }
  }
}
