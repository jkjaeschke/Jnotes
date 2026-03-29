import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";

const client = new OAuth2Client(config.googleClientId);

export type GoogleTokenPayload = {
  email: string;
  sub: string;
  email_verified?: boolean;
};

export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleTokenPayload> {
  if (!config.googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is not configured");
  }
  const ticket = await client.verifyIdToken({
    idToken,
    audience: config.googleClientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) {
    throw new Error("Token missing email");
  }
  if (payload.email_verified === false) {
    throw new Error("Email not verified");
  }
  return {
    email: payload.email,
    sub: payload.sub,
    email_verified: payload.email_verified,
  };
}
