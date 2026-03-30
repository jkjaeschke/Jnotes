import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { z } from "zod";
import { config, corsAllowedOrigins, isEmailAllowed } from "./config.js";
import { verifyGoogleIdToken } from "./auth/google.js";
import {
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
} from "./auth/middleware.js";
import * as store from "./data/store.js";
import { htmlToPlainText } from "./lib/htmlToPlain.js";
import {
  createReadStreamSync,
  gcsObjectExists,
  resumableImportUploadUrl,
  usesGcs,
} from "./lib/storage.js";
import { processImportJob } from "./services/importEnex.js";

mkdirSync(join(config.localDataDir, "blobs"), { recursive: true });

const ENEX_CONTENT_TYPE = "application/xml";

function parseEnexFileName(raw: string | undefined): string | null {
  const fn = (raw?.replace(/^.*[/\\]/, "").trim().slice(0, 500) || "export.enex");
  if (!fn.toLowerCase().endsWith(".enex")) return null;
  return fn;
}

const app = Fastify({ logger: true });

await app.register(cookie);
await app.register(cors, {
  origin: (origin, cb) => {
    const allowed = corsAllowedOrigins();
    if (!origin) return cb(null, true);
    cb(null, allowed.includes(origin));
  },
  credentials: true,
});
await app.register(multipart, {
  limits: { fileSize: 512 * 1024 * 1024 },
});

app.get("/health", async () => ({ ok: true }));

app.post("/api/auth/google", async (request, reply) => {
  const body = request.body as { idToken?: string };
  if (!body?.idToken) {
    return reply.status(400).send({ error: "idToken required" });
  }
  let payload;
  try {
    payload = await verifyGoogleIdToken(body.idToken);
  } catch {
    return reply.status(401).send({ error: "Invalid token" });
  }
  if (!isEmailAllowed(payload.email)) {
    return reply.status(403).send({ error: "Email not allowed" });
  }
  const user = await store.upsertUserByEmail(payload.email);
  await setSessionCookie(reply, user.id);
  return { user: { id: user.id, email: user.email } };
});

app.post("/api/auth/logout", async (_request, reply) => {
  clearSessionCookie(reply);
  return { ok: true };
});

const authPre = { preHandler: requireAuth };

app.get("/api/me", authPre, async (request) => {
  return { user: request.user };
});

app.get("/api/stacks", authPre, async (request) => {
  const list = await store.listStacks(request.user!.id);
  return { stacks: list };
});

app.post("/api/stacks", authPre, async (request, reply) => {
  const schema = z.object({ name: z.string().min(1).max(500) });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  const sortOrder = await store.nextStackSortOrder(request.user!.id);
  const s = await store.createStack(
    request.user!.id,
    parsed.data.name,
    sortOrder
  );
  return { stack: s };
});

app.patch("/api/stacks/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const schema = z.object({
    name: z.string().min(1).max(500).optional(),
    sortOrder: z.number().int().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  const s = await store.updateStack(request.user!.id, id, parsed.data);
  if (!s) return reply.status(404).send({ error: "Not found" });
  return { stack: s };
});

app.delete("/api/stacks/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const ok = await store.deleteStack(request.user!.id, id);
  if (!ok) return reply.status(404).send({ error: "Not found" });
  return { ok: true };
});

app.get("/api/notebooks", authPre, async (request) => {
  const list = await store.listNotebooks(request.user!.id);
  return { notebooks: list };
});

app.post("/api/notebooks", authPre, async (request, reply) => {
  const schema = z.object({
    name: z.string().min(1).max(500),
    stackId: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  let stackId: string | null =
    parsed.data.stackId === undefined ? null : parsed.data.stackId;
  if (stackId) {
    const st = await store.getStack(request.user!.id, stackId);
    if (!st) return reply.status(400).send({ error: "Stack not found" });
  }
  const sortOrder = await store.nextNotebookSortOrder(
    request.user!.id,
    stackId
  );
  const n = await store.createNotebook(
    request.user!.id,
    parsed.data.name,
    sortOrder,
    stackId
  );
  return { notebook: n };
});

app.patch("/api/notebooks/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const schema = z.object({
    name: z.string().min(1).max(500).optional(),
    sortOrder: z.number().int().optional(),
    stackId: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  if (parsed.data.stackId) {
    const st = await store.getStack(request.user!.id, parsed.data.stackId);
    if (!st) return reply.status(400).send({ error: "Stack not found" });
  }
  const n = await store.updateNotebook(request.user!.id, id, parsed.data);
  if (!n) return reply.status(404).send({ error: "Not found" });
  return { notebook: n };
});

app.delete("/api/notebooks/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const { deleteObjectSync } = await import("./lib/storage.js");
  const ok = await store.deleteNotebookCascade(
    request.user!.id,
    id,
    deleteObjectSync
  );
  if (!ok) return reply.status(404).send({ error: "Not found" });
  return { ok: true };
});

app.get("/api/notes", authPre, async (request, reply) => {
  const q = z
    .object({ notebookId: z.string().min(1) })
    .safeParse((request.query as { notebookId?: string }) ?? {});
  if (!q.success) {
    return reply.status(400).send({ error: "notebookId required" });
  }
  const nb = await store.getNotebook(request.user!.id, q.data.notebookId);
  if (!nb) return reply.status(404).send({ error: "Notebook not found" });
  const notes = await store.listNotes(request.user!.id, q.data.notebookId);
  return { notes };
});

app.post("/api/notes", authPre, async (request, reply) => {
  const schema = z.object({
    notebookId: z.string(),
    title: z.string().default(""),
    body: z.string().default(""),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  const nb = await store.getNotebook(
    request.user!.id,
    parsed.data.notebookId
  );
  if (!nb) return reply.status(404).send({ error: "Notebook not found" });
  const bodyText = htmlToPlainText(parsed.data.body);
  const n = await store.createNote(request.user!.id, {
    notebookId: parsed.data.notebookId,
    title: parsed.data.title,
    body: parsed.data.body,
    bodyText,
  });
  return { note: n };
});

app.get("/api/notes/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const n = await store.getNote(request.user!.id, id);
  if (!n) return reply.status(404).send({ error: "Not found" });
  return { note: n };
});

const INLINE_IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;
const MAX_INLINE_IMAGE_BYTES = 30 * 1024 * 1024;

app.post("/api/notes/:id/attachments", authPre, async (request, reply) => {
  const noteId = (request.params as { id: string }).id;
  const note = await store.getNote(request.user!.id, noteId);
  if (!note) return reply.status(404).send({ error: "Not found" });

  const { saveBuffer } = await import("./lib/storage.js");
  const userId = request.user!.id;

  for await (const part of request.parts()) {
    if (part.type !== "file" || part.fieldname !== "file") continue;
    const rawMime = (part.mimetype || "application/octet-stream")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const mime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
    if (!INLINE_IMAGE_MIME.test(mime)) {
      return reply.status(400).send({
        error: "Only PNG, JPEG, GIF, or WebP images are allowed",
      });
    }
    const buf = await part.toBuffer();
    if (buf.length > MAX_INLINE_IMAGE_BYTES) {
      return reply.status(400).send({ error: "Image too large (max 30MB)" });
    }
    const ext =
      mime === "image/png"
        ? "png"
        : mime === "image/jpeg"
          ? "jpg"
          : mime === "image/gif"
            ? "gif"
            : "webp";
    const key = `users/${userId}/notes/${noteId}/inline-${randomUUID()}.${ext}`;
    await saveBuffer(key, buf, mime);
    const att = await store.createAttachment(userId, {
      noteId,
      gcsPath: key,
      mimeType: mime,
      filename: part.filename || `image.${ext}`,
      sizeBytes: buf.length,
    });
    return {
      attachment: {
        id: att.id,
        url: `/api/attachments/${att.id}/file`,
      },
    };
  }
  return reply.status(400).send({ error: "file required" });
});

app.patch("/api/notes/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const schema = z.object({
    notebookId: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  const existing = await store.getNote(request.user!.id, id);
  if (!existing) return reply.status(404).send({ error: "Not found" });
  if (parsed.data.notebookId) {
    const nb = await store.getNotebook(
      request.user!.id,
      parsed.data.notebookId
    );
    if (!nb) return reply.status(400).send({ error: "Invalid notebook" });
  }
  const body =
    parsed.data.body !== undefined ? parsed.data.body : existing.body;
  const bodyText =
    parsed.data.body !== undefined
      ? htmlToPlainText(parsed.data.body)
      : existing.bodyText;
  const n = await store.updateNote(request.user!.id, id, {
    notebookId: parsed.data.notebookId,
    title: parsed.data.title,
    body,
    bodyText,
  });
  if (!n) return reply.status(404).send({ error: "Not found" });
  return { note: n };
});

app.delete("/api/notes/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const { deleteObjectSync } = await import("./lib/storage.js");
  const ok = await store.deleteNote(request.user!.id, id, deleteObjectSync);
  if (!ok) return reply.status(404).send({ error: "Not found" });
  return { ok: true };
});

app.get("/api/search", authPre, async (request, reply) => {
  const q = z
    .object({ q: z.string().min(1).max(500) })
    .safeParse(request.query as { q?: string });
  if (!q.success) {
    return reply.status(400).send({ error: "q required" });
  }
  const userId = request.user!.id;
  const term = q.data.q
    .trim()
    .replace(/[^\w\s\u00C0-\u024F.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (!term) {
    return { hits: [] };
  }
  const hits = await store.searchNotes(userId, term);
  return { hits };
});

/**
 * When GCS is enabled, large ENEX files must not pass through Cloud Run (32 MiB limit).
 * Client should use POST /api/imports/presign → PUT to uploadUrl → POST /api/imports/commit.
 */
app.post("/api/imports/presign", authPre, async (request, reply) => {
  const schema = z.object({ fileName: z.string().min(1).max(500) });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  const fn = parseEnexFileName(parsed.data.fileName);
  if (!fn) {
    return reply.status(400).send({ error: "Expected .enex file" });
  }
  if (!usesGcs()) {
    return { mode: "multipart" as const };
  }
  const jobId = randomUUID();
  const key = `imports/${request.user!.id}/${jobId}/${fn}`;
  const origin =
    typeof request.headers.origin === "string" && request.headers.origin.length > 0
      ? request.headers.origin
      : corsAllowedOrigins()[0];
  try {
    const uploadUrl = await resumableImportUploadUrl(key, ENEX_CONTENT_TYPE, {
      origin,
    });
    return {
      mode: "direct" as const,
      jobId,
      fileName: fn,
      uploadUrl,
      contentType: ENEX_CONTENT_TYPE,
      /** Browser must send Content-Range for this resumable session PUT (see ImportPage). */
      uploadMethod: "resumable" as const,
    };
  } catch (e) {
    request.log.error(e, "imports/presign failed");
    return reply.status(500).send({
      error:
        e instanceof Error ? e.message : "Could not start upload session. Check API logs.",
    });
  }
});

app.post("/api/imports/commit", authPre, async (request, reply) => {
  if (!usesGcs()) {
    return reply
      .status(400)
      .send({ error: "Direct upload is only available when GCS is configured." });
  }
  const schema = z.object({
    jobId: z.string().uuid(),
    fileName: z.string().min(1).max(500),
    notebookId: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid body" });
  }
  const fn = parseEnexFileName(parsed.data.fileName);
  if (!fn) {
    return reply.status(400).send({ error: "Expected .enex file" });
  }
  let notebookId: string | null = parsed.data.notebookId ?? null;
  if (notebookId === "") notebookId = null;

  const key = `imports/${request.user!.id}/${parsed.data.jobId}/${fn}`;
  const existing = await store.getImportJobInternal(parsed.data.jobId);
  if (existing) {
    return reply.status(409).send({ error: "Import job already exists" });
  }
  const ok = await gcsObjectExists(key);
  if (!ok) {
    return reply
      .status(400)
      .send({ error: "Upload not found. Finish the direct upload first." });
  }

  if (notebookId) {
    const nb = await store.getNotebook(request.user!.id, notebookId);
    if (!nb) return reply.status(400).send({ error: "Notebook not found" });
  }

  const job = await store.createImportJob({
    id: parsed.data.jobId,
    userId: request.user!.id,
    gcsStagingKey: key,
    fileName: fn,
    notebookId,
  });

  setImmediate(() => {
    void processImportJob(parsed.data.jobId);
  });

  return { job };
});

app.post("/api/imports", authPre, async (request, reply) => {
  if (usesGcs()) {
    return reply.status(400).send({
      error:
        "Direct upload required for this deployment. The client should use presign → GCS PUT → commit.",
    });
  }

  let notebookId: string | null = null;
  let fileName: string | null = null;
  let stagedKey: string | null = null;
  let newJobId: string | null = null;

  const { saveUploadStream } = await import("./lib/storage.js");

  for await (const part of request.parts()) {
    if (part.type === "field" && part.fieldname === "notebookId") {
      const v = part.value;
      if (typeof v === "string" && v.length > 0) {
        notebookId = v;
      }
    } else if (part.type === "file" && part.fieldname === "file") {
      const fn = parseEnexFileName(part.filename ?? undefined);
      if (!fn) {
        return reply.status(400).send({ error: "Expected .enex file" });
      }
      const jobId = randomUUID();
      newJobId = jobId;
      const key = `imports/${request.user!.id}/${jobId}/${fn}`;
      await saveUploadStream(key, part.file, "application/xml");
      fileName = fn;
      stagedKey = key;
    }
  }

  if (!stagedKey || !fileName || !newJobId) {
    return reply.status(400).send({ error: "file required" });
  }

  if (notebookId) {
    const nb = await store.getNotebook(request.user!.id, notebookId);
    if (!nb) return reply.status(400).send({ error: "Notebook not found" });
  }

  const job = await store.createImportJob({
    id: newJobId,
    userId: request.user!.id,
    gcsStagingKey: stagedKey,
    fileName,
    notebookId,
  });

  setImmediate(() => {
    void processImportJob(newJobId);
  });

  return { job };
});

app.get("/api/imports", authPre, async (request) => {
  const jobs = await store.listImportJobs(request.user!.id, 50);
  return { jobs };
});

app.get("/api/imports/:id", authPre, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const job = await store.getImportJobInternal(id);
  if (!job || job.userId !== request.user!.id) {
    return reply.status(404).send({ error: "Not found" });
  }
  const { userId: _u, gcsStagingKey: _g, ...rest } = job;
  return { job: rest };
});

app.get("/api/attachments/:id/file", async (request, reply) => {
  await requireAuth(request, reply);
  if (reply.sent) return;
  const id = (request.params as { id: string }).id;
  const att = await store.getAttachment(request.user!.id, id);
  if (!att) return reply.status(404).send({ error: "Not found" });
  // Stream from storage directly (works for both local + GCS) and avoids
  // signed URL requirements (iam.serviceAccounts.signBlob) in Cloud Run.
  const stream = createReadStreamSync(att.gcsPath);
  reply.header("Content-Type", att.mimeType);
  // Keep images inline; other files will download in most browsers anyway.
  return reply.send(stream);
});

if (config.staticDir && existsSync(config.staticDir)) {
  await app.register(fastifyStatic, {
    root: config.staticDir,
    prefix: "/",
    decorateReply: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api")) {
      return reply.status(404).send({ error: "Not found" });
    }
    const html = readFileSync(join(config.staticDir, "index.html"), "utf8");
    return reply.type("text/html").send(html);
  });
}

await app.listen({ port: config.port, host: "0.0.0.0" });
