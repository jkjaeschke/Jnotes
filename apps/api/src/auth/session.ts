import * as jose from "jose";
import { config } from "../config.js";

function getKey(): Uint8Array {
  return new TextEncoder().encode(config.sessionSecret);
}

export async function signSessionToken(userId: string): Promise<string> {
  return new jose.SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getKey());
}

export async function verifySessionToken(
  token: string
): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getKey());
    if (typeof payload.sub === "string") return { sub: payload.sub };
  } catch {
    /* invalid */
  }
  return null;
}
