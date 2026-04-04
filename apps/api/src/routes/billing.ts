import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import Stripe from "stripe";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import * as store from "../data/store.js";

type RequestWithRaw = FastifyRequest & { rawBody?: Buffer };

const authPre = { preHandler: requireAuth };

export async function registerBillingRoutes(app: FastifyInstance) {
  app.post(
    "/api/billing/checkout",
    authPre,
    async (request, reply) => {
      if (!config.stripeSecretKey || !config.stripePriceIdAi) {
        return reply.status(503).send({
          error:
            "Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID_AI, or grant AI in Firestore (users.plan = \"ai\").",
        });
      }
      const origin =
        typeof request.headers.origin === "string" && request.headers.origin.length > 0
          ? request.headers.origin
          : config.frontendOrigin;
      const stripe = new Stripe(config.stripeSecretKey);
      const userId = request.user!.id;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: config.stripePriceIdAi, quantity: 1 }],
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancel`,
        client_reference_id: userId,
        metadata: { userId },
        subscription_data: {
          metadata: { userId },
        },
      });
      return { url: session.url };
    }
  );

  app.post(
    "/api/billing/webhook",
    {
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buf = Buffer.concat(chunks);
        (request as RequestWithRaw).rawBody = buf;
        return Readable.from(buf);
      },
    },
    async (request, reply) => {
      if (!config.stripeWebhookSecret || !config.stripeSecretKey) {
        if (config.nodeEnv === "production") {
          return reply.status(503).send({ error: "Webhook not configured" });
        }
        return reply.status(503).send({
          error: "Set STRIPE_WEBHOOK_SECRET and STRIPE_SECRET_KEY to process webhooks.",
        });
      }
      const sig = request.headers["stripe-signature"];
      if (typeof sig !== "string") {
        return reply.status(400).send({ error: "Missing stripe-signature" });
      }
      const raw = (request as RequestWithRaw).rawBody;
      if (!raw) {
        return reply.status(400).send({ error: "Empty body" });
      }
      const stripe = new Stripe(config.stripeSecretKey);
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          raw,
          sig,
          config.stripeWebhookSecret
        );
      } catch (e) {
        return reply.status(400).send({
          error: e instanceof Error ? e.message : "Invalid signature",
        });
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId =
          session.metadata?.userId ??
          session.client_reference_id ??
          undefined;
        if (userId) {
          await store.setUserPlan(userId, "ai");
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.userId;
        if (userId) {
          await store.setUserPlan(userId, "free");
        }
      }

      return { received: true };
    }
  );
}
