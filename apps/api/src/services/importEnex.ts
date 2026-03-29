import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import * as store from "../data/store.js";
import { htmlToPlainText } from "../lib/htmlToPlain.js";
import { parseEnexStream, type ParsedNote } from "../lib/enexStreamParser.js";
import {
  createReadStreamSync,
  deleteObjectSync,
  saveBuffer,
} from "../lib/storage.js";

function md5Hex(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

type MappedRes = { hash: string; fileUrl: string; mime: string };

function replaceEnMediaWithAttachments(html: string, resources: MappedRes[]): string {
  if (!resources.length) return html;
  const byHash = new Map(resources.map((r) => [r.hash, r]));
  let out = html;
  const re = /<en-media\b[^>]*>/gi;
  out = out.replace(re, (tag) => {
    const hashMatch = /\bhash="([^"]+)"/i.exec(tag);
    const typeMatch = /\btype="([^"]+)"/i.exec(tag);
    const hash = hashMatch?.[1]?.toLowerCase();
    if (!hash) return tag;
    const r = byHash.get(hash);
    if (!r) return tag;
    const mime = typeMatch?.[1] ?? r.mime;
    if (mime.startsWith("image/")) {
      return `<img src="${r.fileUrl}" alt="" />`;
    }
    return `<a href="${r.fileUrl}" download>attachment</a>`;
  });
  const leftover = resources.filter((r) => !out.includes(r.fileUrl));
  if (leftover.length) {
    const list = leftover
      .map((r) => `<li><a href="${r.fileUrl}">${r.mime}</a></li>`)
      .join("");
    out += `<hr/><p><strong>Attachments</strong></p><ul>${list}</ul>`;
  }
  return out;
}

async function uploadResources(
  userId: string,
  noteId: string,
  resources: ParsedNote["resources"]
): Promise<MappedRes[]> {
  const out: MappedRes[] = [];
  for (const res of resources) {
    const hash = md5Hex(res.data);
    const safeName = res.filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const key = `users/${userId}/notes/${noteId}/${hash}-${safeName}`;
    await saveBuffer(key, res.data, res.mime);
    const att = await store.createAttachment(userId, {
      noteId,
      gcsPath: key,
      mimeType: res.mime,
      filename: res.filename,
      sizeBytes: res.data.length,
    });
    out.push({
      hash,
      fileUrl: `/api/attachments/${att.id}/file`,
      mime: res.mime,
    });
  }
  return out;
}

async function persistNote(
  userId: string,
  notebookId: string,
  parsed: ParsedNote
): Promise<void> {
  const title = parsed.title || "Untitled";
  const guid = parsed.guid;

  if (guid) {
    const existing = await store.findNoteByEvernoteGuid(userId, guid);
    if (existing) {
      await store.deleteAttachmentsForNoteId(userId, existing.id, deleteObjectSync);
      const mapped = await uploadResources(userId, existing.id, parsed.resources);
      const body = replaceEnMediaWithAttachments(parsed.content, mapped);
      const bodyText = htmlToPlainText(body);
      await store.updateNote(userId, existing.id, {
        title,
        body,
        bodyText,
        notebookId,
        updatedAt: parsed.updated ?? undefined,
      });
      return;
    }
  }

  const note = await store.createNote(userId, {
    notebookId,
    title,
    body: "",
    bodyText: "",
    evernoteGuid: guid,
    createdAt: parsed.created ?? undefined,
    updatedAt: parsed.updated ?? undefined,
  });

  const mapped = await uploadResources(userId, note.id, parsed.resources);
  const body = replaceEnMediaWithAttachments(parsed.content, mapped);
  const bodyText = htmlToPlainText(body);

  await store.updateNote(userId, note.id, {
    body,
    bodyText,
    // Second write must keep Evernote times; otherwise updateNote() uses server time for all notes.
    updatedAt: parsed.updated ?? parsed.created ?? undefined,
  });
}

export async function processImportJob(jobId: string): Promise<void> {
  const job = await store.getImportJobInternal(jobId);
  if (!job || job.status !== "pending") return;

  await store.updateImportJob(jobId, { status: "processing" });

  let notebookId = job.notebookId;
  if (!notebookId) {
    const base =
      job.fileName?.replace(/\.enex$/i, "").trim() || "Imported notebook";
    const sortOrder = await store.nextNotebookSortOrder(job.userId, null);
    const nb = await store.createNotebook(
      job.userId,
      base.slice(0, 200),
      sortOrder,
      null
    );
    notebookId = nb.id;
    await store.updateImportJob(jobId, { notebookId });
  }

  const nb = await store.getNotebook(job.userId, notebookId);
  if (!nb) {
    await store.updateImportJob(jobId, {
      status: "failed",
      error: "Notebook not found",
    });
    return;
  }

  let created = 0;
  let skipped = 0;

  try {
    const stream = createReadStreamSync(job.gcsStagingKey) as Readable;

    await parseEnexStream(stream, async (parsed: ParsedNote) => {
      try {
        await persistNote(job.userId, notebookId!, parsed);
        created += 1;
      } catch {
        skipped += 1;
      }
    });

    await store.updateImportJob(jobId, {
      status: "completed",
      notesCreated: created,
      notesSkipped: skipped,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.updateImportJob(jobId, {
      status: "failed",
      error: msg,
      notesCreated: created,
      notesSkipped: skipped,
    });
  }
}
