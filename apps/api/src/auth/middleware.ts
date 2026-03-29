import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyGoogleIdToken } from "./google.js";
import { signSessionToken, verifySessionToken } from "./session.js";
import { config, isEmailAllowed } from "../config.js";
import { getUserById, upsertUserByEmail } from "../data/store.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; email: string };
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
        request.user = { id: user.id, email: user.email };
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
  request.user = { id: user.id, email: user.email };
}

export async function setSessionCookie(
  reply: FastifyReply,
  userId: string
): Promise<void> {
  const token = await signSessionToken(userId);
  const isProd = config.nodeEnv === "production";
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: "/" });
}
