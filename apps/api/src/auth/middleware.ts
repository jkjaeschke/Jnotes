import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyGoogleIdToken } from "./google.js";
import { signSessionToken, verifySessionToken } from "./session.js";
import { config, isEmailAllowed } from "../config.js";
import type { StoredPlan } from "../lib/aiAccess.js";
import { userHasAiTier } from "../lib/aiAccess.js";
import { getUserById, upsertUserByEmail } from "../data/store.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; email: string; plan: StoredPlan };
  }
}

const COOKIE = "freenotes_session";

export function getSessionCookieName(): string {
  return COOKIE;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const cookieTok = request.cookies?.[COOKIE];
  if (cookieTok) {
    const v = await verifySessionToken(cookieTok);
    if (v) {
      const user = await getUserById(v.sub);
      if (user) {
        request.user = { id: user.id, email: user.email, plan: user.plan };
        return;
      }
    }
  }

  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    void reply.status(401).send({ error: "Unauthorized" });
    return;
  }
  const idToken = auth.slice("Bearer ".length).trim();
  if (!idToken) {
    void reply.status(401).send({ error: "Unauthorized" });
    return;
  }
  let payload;
  try {
    payload = await verifyGoogleIdToken(idToken);
  } catch {
    void reply.status(401).send({ error: "Invalid token" });
    return;
  }
  if (!isEmailAllowed(payload.email)) {
    void reply.status(403).send({ error: "Email not allowed" });
    return;
  }
  const user = await upsertUserByEmail(payload.email);
  const profile = await getUserById(user.id);
  request.user = {
    id: user.id,
    email: user.email,
    plan: profile?.plan ?? "free",
  };
}

export async function requireAiTier(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const u = request.user;
  if (!u) {
    void reply.status(401).send({ error: "Unauthorized" });
    return;
  }
  if (!userHasAiTier(u.email, u.plan)) {
    void reply.status(403).send({ error: "AI tier required" });
    return;
  }
}

export async function setSessionCookie(
  reply: FastifyReply,
  userId: string
): Promise<void> {
  const token = await signSessionToken(userId);
  const isProd = config.nodeEnv === "production";
  // Cross-origin SPA (e.g. Vercel → Cloud Run) requires SameSite=None; Lax cookies are not
  // sent on credentialed fetches to another site, so /api/* calls fail after refresh.
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  const isProd = config.nodeEnv === "production";
  reply.clearCookie(COOKIE, {
    path: "/",
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
  });
}
