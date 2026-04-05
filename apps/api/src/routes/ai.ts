import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAiTier, requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import * as store from "../data/store.js";
import {
  isEmptyNoteBody,
  rankSimilarNotes,
} from "../lib/aiSimilarity.js";
import { buildMergedNotesHtml } from "../lib/aiMerge.js";
import { suggestNotebookMoves } from "../lib/aiOrganize.js";
import {
  cleanupNoteForSharingHtml,
  rewriteNoteHtml,
  type RewritePreset,
} from "../lib/aiRewrite.js";
import { tidyHtml } from "../lib/tidyHtml.js";
import { htmlToPlainText } from "../lib/htmlToPlain.js";

const aiPre = { preHandler: [requireAuth, requireAiTier] };
const AI_BODY_LIMIT = 2 * 1024 * 1024;

const presetSchema = z.enum(["concise", "meeting", "checklist"]);

export function registerAiRoutes(app: FastifyInstance) {
  app.post(
    "/api/ai/tidy-html",
    { ...aiPre, bodyLimit: AI_BODY_LIMIT },
    async (request, reply) => {
      const schema = z.object({
        html: z.string().max(AI_BODY_LIMIT),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body" });
      }
      try {
        const html = tidyHtml(parsed.data.html);
        return { html };
      } catch (e) {
        return reply.status(400).send({
          error: e instanceof Error ? e.message : "Tidy failed",
        });
      }
    }
  );

  app.post("/api/ai/similar-notes", aiPre, async (request, reply) => {
    const schema = z.object({
      noteId: z.string().min(1),
      scope: z.enum(["notebook", "all"]).optional().default("notebook"),
      limit: z.number().int().min(1).max(50).optional().default(15),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body" });
    }
    const userId = request.user!.id;
    const note = await store.getNote(userId, parsed.data.noteId);
    if (!note) return reply.status(404).send({ error: "Note not found" });

    const summaries = await store.listNoteSummariesForAi(userId, {
      notebookId: parsed.data.scope === "notebook" ? note.notebookId : undefined,
      limit: 450,
    });
    const source: store.NoteAiSummary = {
      id: note.id,
      notebookId: note.notebookId,
      title: note.title,
      bodyText: note.bodyText,
    };
    const nonEmptyForRank = summaries.filter(
      (s) => s.id === note.id || !isEmptyNoteBody(s.bodyText)
    );
    const ranked = rankSimilarNotes(source, nonEmptyForRank, parsed.data.limit);
    const titleById = new Map(summaries.map((s) => [s.id, s.title]));
    const emptyNotes = summaries
      .filter(
        (s) => s.id !== note.id && isEmptyNoteBody(s.bodyText)
      )
      .map((s) => {
        const raw = (s.bodyText ?? "").trim();
        const bodyPreview =
          raw.length > 0 ? raw.slice(0, 2_000) : "";
        return {
          id: s.id,
          title: (s.title ?? "").trim() || "Untitled",
          bodyPreview,
        };
      })
      .slice(0, 80);
    return {
      candidates: ranked.map((c) => ({
        id: c.id,
        score: c.score,
        reason: c.reason,
        title: (titleById.get(c.id) ?? "").trim() || "Untitled",
      })),
      emptyNotes,
    };
  });

  app.post(
    "/api/ai/merge-preview",
    { ...aiPre, bodyLimit: AI_BODY_LIMIT },
    async (request, reply) => {
      const schema = z.object({
        primaryNoteId: z.string().min(1),
        otherNoteIds: z.array(z.string().min(1)).min(1).max(20),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body" });
      }
      const userId = request.user!.id;
      const { primaryNoteId, otherNoteIds } = parsed.data;
      const uniqOthers = [...new Set(otherNoteIds)].filter(
        (id) => id !== primaryNoteId
      );
      if (uniqOthers.length === 0) {
        return reply.status(400).send({ error: "otherNoteIds must include notes other than the primary" });
      }
      const primary = await store.getNote(userId, primaryNoteId);
      if (!primary) return reply.status(404).send({ error: "Primary note not found" });
      const ordered: { id: string; title: string; body: string }[] = [
        { id: primary.id, title: primary.title, body: primary.body },
      ];
      for (const id of uniqOthers) {
        const n = await store.getNote(userId, id);
        if (!n) return reply.status(404).send({ error: `Note not found: ${id}` });
        ordered.push({ id: n.id, title: n.title, body: n.body });
      }
      const { mergedHtml, warnings } = buildMergedNotesHtml(ordered);
      const beforeText = htmlToPlainText(primary.body);
      const afterText = htmlToPlainText(mergedHtml);
      return {
        mergedHtml,
        warnings,
        beforeHtml: primary.body,
        beforeText,
        afterText,
      };
    }
  );

  app.post(
    "/api/ai/cleanup-note",
    { ...aiPre, bodyLimit: AI_BODY_LIMIT },
    async (request, reply) => {
      const schema = z.object({
        html: z.string().min(1).max(AI_BODY_LIMIT),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body" });
      }
      if (!config.openaiApiKey) {
        return reply.status(503).send({
          error:
            "Cleanup needs OPENAI_API_KEY or OPENAI_API_KEY_SECRET (GCP Secret Manager).",
        });
      }
      const userId = request.user!.id;
      const inputHtml = parsed.data.html;
      const beforeText = htmlToPlainText(inputHtml);
      const allowed = await store.consumeAiRewriteQuota(
        userId,
        config.aiRewriteMonthlyCap
      );
      if (!allowed) {
        return reply.status(429).send({
          error: `Monthly AI edit limit reached (${config.aiRewriteMonthlyCap}).`,
        });
      }
      try {
        const html = await cleanupNoteForSharingHtml(inputHtml);
        const afterText = htmlToPlainText(html);
        return { html, beforeText, afterText };
      } catch (e) {
        await store.refundAiRewriteQuota(userId);
        return reply.status(502).send({
          error: e instanceof Error ? e.message : "Cleanup failed",
        });
      }
    }
  );

  app.post(
    "/api/ai/merge-commit",
    { ...aiPre, bodyLimit: AI_BODY_LIMIT },
    async (request, reply) => {
      const schema = z.object({
        primaryNoteId: z.string().min(1),
        otherNoteIds: z.array(z.string().min(1)).min(1).max(20),
        mergedHtml: z.string().min(1).max(AI_BODY_LIMIT),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body" });
      }
      const userId = request.user!.id;
      const { primaryNoteId, otherNoteIds, mergedHtml } = parsed.data;
      const uniqOthers = [...new Set(otherNoteIds)].filter(
        (id) => id !== primaryNoteId
      );
      if (uniqOthers.length === 0) {
        return reply.status(400).send({ error: "otherNoteIds must include notes other than the primary" });
      }
      const bodyText = htmlToPlainText(mergedHtml);
      const { deleteObjectSync } = await import("../lib/storage.js");
      const result = await store.commitNoteMerge(
        userId,
        primaryNoteId,
        uniqOthers,
        mergedHtml,
        bodyText,
        deleteObjectSync
      );
      if (!result.ok) {
        return reply.status(400).send({ error: result.error });
      }
      const note = await store.getNote(userId, primaryNoteId);
      return { ok: true, note };
    }
  );

  app.post("/api/ai/suggest-notebooks", aiPre, async (request, reply) => {
    const schema = z.object({
      noteIds: z.array(z.string().min(1)).min(1).max(80),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body" });
    }
    const userId = request.user!.id;
    const notebooks = await store.listNotebooks(userId);
    const nbStubs = notebooks.map((n) => ({ id: n.id, name: n.name }));
    const summaries: store.NoteAiSummary[] = [];
    for (const id of parsed.data.noteIds) {
      const note = await store.getNote(userId, id);
      if (!note) continue;
      summaries.push({
        id: note.id,
        notebookId: note.notebookId,
        title: note.title,
        bodyText: note.bodyText,
      });
    }
    const suggestions = suggestNotebookMoves(summaries, nbStubs);
    return { suggestions };
  });

  app.post("/api/ai/apply-suggestions", aiPre, async (request, reply) => {
    const schema = z.object({
      applies: z
        .array(
          z.object({
            noteId: z.string().min(1),
            notebookId: z.string().min(1),
          })
        )
        .min(1)
        .max(50),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body" });
    }
    const userId = request.user!.id;
    const updated: NonNullable<Awaited<ReturnType<typeof store.updateNote>>>[] = [];
    for (const a of parsed.data.applies) {
      const nb = await store.getNotebook(userId, a.notebookId);
      if (!nb) {
        return reply.status(400).send({ error: `Notebook not found: ${a.notebookId}` });
      }
      const n = await store.getNote(userId, a.noteId);
      if (!n) {
        return reply.status(400).send({ error: `Note not found: ${a.noteId}` });
      }
      const after = await store.updateNote(userId, a.noteId, {
        notebookId: a.notebookId,
      });
      if (after) updated.push(after);
    }
    return { notes: updated };
  });

  app.post(
    "/api/ai/rewrite",
    { ...aiPre, bodyLimit: AI_BODY_LIMIT },
    async (request, reply) => {
      const schema = z.object({
        html: z.string().min(1).max(AI_BODY_LIMIT),
        preset: presetSchema,
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid body" });
      }
      if (!config.openaiApiKey) {
        return reply.status(503).send({
          error:
            "Rewrite needs OPENAI_API_KEY or OPENAI_API_KEY_SECRET (GCP Secret Manager). Optional: OPENAI_API_BASE, OPENAI_MODEL.",
        });
      }
      const userId = request.user!.id;
      const allowed = await store.consumeAiRewriteQuota(
        userId,
        config.aiRewriteMonthlyCap
      );
      if (!allowed) {
        return reply.status(429).send({
          error: `Monthly rewrite limit reached (${config.aiRewriteMonthlyCap}).`,
        });
      }
      try {
        const html = await rewriteNoteHtml(
          parsed.data.html,
          parsed.data.preset as RewritePreset
        );
        return { html };
      } catch (e) {
        await store.refundAiRewriteQuota(userId);
        return reply.status(502).send({
          error: e instanceof Error ? e.message : "Rewrite failed",
        });
      }
    }
  );
}
