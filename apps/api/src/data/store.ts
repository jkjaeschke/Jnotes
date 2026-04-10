/**
 * Firestore data model (all scoped by userId where applicable):
 *   stacks/{id}        — name, sortOrder; groups notebooks (Evernote "stack")
 *   notebooks/{id}     — name, sortOrder, stackId (null = ungrouped); contains many notes
 *   notes/{id}         — notebookId, title, body, bodyText, optional evernoteGuid
 *   attachments/{id}   — noteId, blob metadata
 *   importJobs/{id}    — ENEX import staging
 *   feedback/{id}      — user-submitted product feedback (userId, email, message)
 */
import { createHash } from "node:crypto";
import type {
  DocumentSnapshot,
  QueryDocumentSnapshot,
} from "@google-cloud/firestore";
import { FieldPath, FieldValue, Timestamp } from "@google-cloud/firestore";
import { db } from "../firestore/client.js";
import type { StoredPlan } from "../lib/aiAccess.js";
import { normalizeStoredPlan } from "../lib/aiAccess.js";

export function userIdFromEmail(email: string): string {
  const norm = email.toLowerCase().trim();
  return `u${createHash("sha256").update(`freenotes|${norm}`).digest("hex").slice(0, 40)}`;
}

function tsToIso(t: Timestamp | undefined): string {
  if (!t?.toDate) return new Date().toISOString();
  return t.toDate().toISOString();
}

const NOTE_TIME_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Firestore Timestamp only; missing/invalid → null (never “now”, which broke sort). */
function noteTimestampToIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof (v as Timestamp).toDate === "function") {
    return (v as Timestamp).toDate().toISOString();
  }
  return null;
}

function noteRecencyMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/** Raise notebook.lastNoteActivityAt to at least candidateMs (max note recency in that notebook). */
async function touchNotebookLastNoteActivity(
  userId: string,
  notebookId: string,
  candidateMs: number
): Promise<void> {
  if (candidateMs <= 0) return;
  const ref = db.collection("notebooks").doc(notebookId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()!.userId !== userId) return;
      const cur = snap.data()!.lastNoteActivityAt as Timestamp | undefined;
      const curMs = cur?.toMillis?.() ?? 0;
      if (candidateMs <= curMs) return;
      tx.update(ref, {
        lastNoteActivityAt: Timestamp.fromMillis(candidateMs),
      });
    });
  } catch {
    // Ordering hint only; note create/update already succeeded.
  }
}

export async function upsertUserByEmail(
  email: string
): Promise<{ id: string; email: string }> {
  const id = userIdFromEmail(email);
  const ref = db.collection("users").doc(id);
  await ref.set(
    {
      email,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { id, email };
}

export async function getUserById(
  id: string
): Promise<{ id: string; email: string; plan: StoredPlan } | null> {
  const snap = await db.collection("users").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  return {
    id: snap.id,
    email: d.email as string,
    plan: normalizeStoredPlan(d.plan),
  };
}

export async function setUserPlan(userId: string, plan: StoredPlan) {
  await db
    .collection("users")
    .doc(userId)
    .set(
      {
        plan,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

/**
 * Atomically increment monthly rewrite usage; returns false if over cap.
 */
export async function consumeAiRewriteQuota(
  userId: string,
  maxPerMonth: number
): Promise<boolean> {
  const ref = db.collection("users").doc(userId);
  const monthKey = new Date().toISOString().slice(0, 7);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const d = snap.data()!;
      const prevMonth = (d.aiRewriteMonth as string | undefined) ?? "";
      let count = (d.aiRewriteCount as number | undefined) ?? 0;
      if (prevMonth !== monthKey) count = 0;
      if (count >= maxPerMonth) return false;
      tx.update(ref, {
        aiRewriteMonth: monthKey,
        aiRewriteCount: count + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch {
    return false;
  }
}

/** Decrements rewrite count after a failed provider call (pair with `consumeAiRewriteQuota`). */
export async function refundAiRewriteQuota(userId: string): Promise<void> {
  const ref = db.collection("users").doc(userId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const d = snap.data()!;
      const month = (d.aiRewriteMonth as string | undefined) ?? "";
      let c = (d.aiRewriteCount as number | undefined) ?? 0;
      if (c <= 0) return;
      tx.update(ref, {
        aiRewriteCount: c - 1,
        aiRewriteMonth: month,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch {
    // ignore
  }
}

export type NoteAiSummary = {
  id: string;
  notebookId: string;
  title: string;
  bodyText: string;
};

/** Lightweight rows for similarity / organize (caps Firestore reads). */
export async function listNoteSummariesForAi(
  userId: string,
  opts: { notebookId?: string; limit?: number }
): Promise<NoteAiSummary[]> {
  const cap = Math.min(Math.max(opts.limit ?? 400, 1), 500);
  let q = db.collection("notes").where("userId", "==", userId);
  if (opts.notebookId) {
    q = q.where("notebookId", "==", opts.notebookId);
  }
  const snap = await q.limit(cap).get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      notebookId: d.notebookId as string,
      title: (d.title as string) ?? "",
      bodyText: (d.bodyText as string) ?? "",
    };
  });
}

type AttachmentRow = { docId: string; gcsPath: string };

/**
 * Update the primary note with merged HTML, delete secondary notes and their attachment rows,
 * then remove blobs (after the transaction commits).
 */
export async function commitNoteMerge(
  userId: string,
  primaryNoteId: string,
  otherNoteIds: string[],
  mergedBody: string,
  mergedBodyText: string,
  deleteBlob: (key: string) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  const others = [...new Set(otherNoteIds)].filter((id) => id && id !== primaryNoteId);
  if (others.length === 0) {
    return { ok: false, error: "At least one other note is required" };
  }

  const primaryRef = db.collection("notes").doc(primaryNoteId);
  const primarySnap = await primaryRef.get();
  if (!primarySnap.exists || primarySnap.data()!.userId !== userId) {
    return { ok: false, error: "Primary note not found" };
  }

  const secondaryRefs = others.map((id) => db.collection("notes").doc(id));
  for (const ref of secondaryRefs) {
    const s = await ref.get();
    if (!s.exists || s.data()!.userId !== userId) {
      return { ok: false, error: "One or more notes to merge were not found" };
    }
  }

  const attachmentsByNote = new Map<string, AttachmentRow[]>();
  for (const noteId of others) {
    const asnap = await db
      .collection("attachments")
      .where("noteId", "==", noteId)
      .get();
    const rows: AttachmentRow[] = [];
    for (const doc of asnap.docs) {
      if (doc.data().userId !== userId) continue;
      rows.push({
        docId: doc.id,
        gcsPath: doc.data().gcsPath as string,
      });
    }
    attachmentsByNote.set(noteId, rows);
  }

  try {
    await db.runTransaction(async (tx) => {
      const pR = await tx.get(primaryRef);
      if (!pR.exists || pR.data()!.userId !== userId) {
        throw new Error("primary");
      }
      for (const ref of secondaryRefs) {
        const s = await tx.get(ref);
        if (!s.exists || s.data()!.userId !== userId) throw new Error("secondary");
      }
      tx.update(primaryRef, {
        body: mergedBody,
        bodyText: mergedBodyText,
        updatedAt: FieldValue.serverTimestamp(),
      });
      for (const ref of secondaryRefs) {
        tx.delete(ref);
      }
      for (const noteId of others) {
        for (const a of attachmentsByNote.get(noteId) ?? []) {
          tx.delete(db.collection("attachments").doc(a.docId));
        }
      }
    });
  } catch {
    return { ok: false, error: "Merge failed; no changes were saved" };
  }

  for (const noteId of others) {
    for (const a of attachmentsByNote.get(noteId) ?? []) {
      deleteBlob(a.gcsPath);
    }
  }

  const mergedNotebookId = primarySnap.data()!.notebookId as string;
  await refreshNotebookLastNoteActivityFromNotes(userId, mergedNotebookId);

  return { ok: true };
}

function notebookFromDoc(doc: DocumentSnapshot | QueryDocumentSnapshot) {
  const d = doc.data()!;
  const lat = d.lastNoteActivityAt as Timestamp | undefined;
  const rawSid = d.stackId as string | undefined | null;
  const stackId =
    rawSid == null || (typeof rawSid === "string" && rawSid.trim() === "")
      ? null
      : rawSid;
  return {
    id: doc.id,
    name: d.name as string,
    sortOrder: (d.sortOrder as number | undefined) ?? 0,
    stackId,
    createdAt: tsToIso(d.createdAt as Timestamp),
    updatedAt: tsToIso(d.updatedAt as Timestamp),
    lastNoteActivityAt:
      lat != null && typeof lat.toMillis === "function" ? tsToIso(lat) : null,
  };
}

export async function listStacks(userId: string) {
  const snap = await db
    .collection("stacks")
    .where("userId", "==", userId)
    .get();
  const list = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      name: d.name as string,
      sortOrder: (d.sortOrder as number | undefined) ?? 0,
      createdAt: tsToIso(d.createdAt as Timestamp),
      updatedAt: tsToIso(d.updatedAt as Timestamp),
    };
  });
  list.sort((a, b) => a.sortOrder - b.sortOrder);
  return list;
}

export async function nextStackSortOrder(userId: string): Promise<number> {
  const snap = await db
    .collection("stacks")
    .where("userId", "==", userId)
    .get();
  let max = 0;
  for (const doc of snap.docs) {
    const so = (doc.data().sortOrder as number) ?? 0;
    if (so > max) max = so;
  }
  return max + 1;
}

export async function createStack(userId: string, name: string, sortOrder: number) {
  const ref = db.collection("stacks").doc();
  const now = FieldValue.serverTimestamp();
  await ref.set({
    userId,
    name,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  });
  const snap = await ref.get();
  const d = snap.data()!;
  return {
    id: ref.id,
    name: d.name as string,
    sortOrder: d.sortOrder as number,
    createdAt: tsToIso(d.createdAt as Timestamp),
    updatedAt: tsToIso(d.updatedAt as Timestamp),
  };
}

export async function getStack(userId: string, id: string) {
  const snap = await db.collection("stacks").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  if (d.userId !== userId) return null;
  return {
    id: snap.id,
    name: d.name as string,
    sortOrder: d.sortOrder as number,
    createdAt: tsToIso(d.createdAt as Timestamp),
    updatedAt: tsToIso(d.updatedAt as Timestamp),
  };
}

export async function updateStack(
  userId: string,
  id: string,
  patch: { name?: string; sortOrder?: number }
) {
  const ref = db.collection("stacks").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if (snap.data()!.userId !== userId) return null;
  await ref.update({
    ...patch,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const after = await ref.get();
  const ad = after.data()!;
  return {
    id: ref.id,
    name: ad.name as string,
    sortOrder: ad.sortOrder as number,
    createdAt: tsToIso(ad.createdAt as Timestamp),
    updatedAt: tsToIso(ad.updatedAt as Timestamp),
  };
}

export async function deleteStack(userId: string, id: string) {
  const ref = db.collection("stacks").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if (snap.data()!.userId !== userId) return false;

  let lastSnap: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db
      .collection("notebooks")
      .where("userId", "==", userId)
      .where("stackId", "==", id)
      .orderBy(FieldPath.documentId())
      .limit(400);
    if (lastSnap) q = q.startAfter(lastSnap);
    const batch = db.batch();
    const nq = await q.get();
    if (nq.empty) break;
    for (const doc of nq.docs) {
      batch.update(doc.ref, {
        stackId: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    lastSnap = nq.docs[nq.docs.length - 1];
    if (nq.size < 400) break;
  }
  await ref.delete();
  return true;
}

function noteDocMaxRecencyMs(doc: QueryDocumentSnapshot): number {
  const d = doc.data()!;
  const createdAt = noteTimestampToIso(d.createdAt) ?? NOTE_TIME_EPOCH_ISO;
  const updatedAt = noteTimestampToIso(d.updatedAt) ?? createdAt;
  return Math.max(noteRecencyMs(createdAt), noteRecencyMs(updatedAt));
}

/** Recompute from all notes in the notebook (delete, import batch, merge). */
export async function refreshNotebookLastNoteActivityFromNotes(
  userId: string,
  notebookId: string
): Promise<void> {
  const ref = db.collection("notebooks").doc(notebookId);
  const ns = await ref.get();
  if (!ns.exists || ns.data()!.userId !== userId) return;

  const snap = await db
    .collection("notes")
    .where("userId", "==", userId)
    .where("notebookId", "==", notebookId)
    .get();
  let maxMs = 0;
  for (const doc of snap.docs) {
    maxMs = Math.max(maxMs, noteDocMaxRecencyMs(doc));
  }

  if (maxMs === 0) {
    await ref.update({ lastNoteActivityAt: FieldValue.delete() });
  } else {
    await ref.update({
      lastNoteActivityAt: Timestamp.fromMillis(maxMs),
    });
  }
}

/**
 * List notebooks ordered by most recent note activity (max of note created/updated times per
 * notebook), then notebook metadata for empty notebooks, with sortOrder/name as tie-breakers.
 */
export async function listNotebooks(userId: string) {
  const snap = await db
    .collection("notebooks")
    .where("userId", "==", userId)
    .get();
  const list = snap.docs.map((doc) => notebookFromDoc(doc));
  const notebookIds = new Set(list.map((n) => n.id));

  /** Max of each note's recency (latest of created/updated) per notebook; requires a full scan. */
  const lastNoteActivityMs = new Map<string, number>();
  let lastDoc: QueryDocumentSnapshot | undefined;
  const pageSize = 400;

  try {
    for (;;) {
      let q = db
        .collection("notes")
        .where("userId", "==", userId)
        .orderBy("updatedAt", "desc")
        .limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const nq = await q.get();
      if (nq.empty) break;
      for (const doc of nq.docs) {
        const nbId = doc.data().notebookId as string;
        if (!notebookIds.has(nbId)) continue;
        const ms = noteDocMaxRecencyMs(doc);
        const prev = lastNoteActivityMs.get(nbId);
        if (prev === undefined || ms > prev) {
          lastNoteActivityMs.set(nbId, ms);
        }
      }
      if (nq.size < pageSize) break;
      lastDoc = nq.docs[nq.docs.length - 1]!;
    }
  } catch (e) {
    // Missing Firestore index or transient error — still return notebooks (manual sort).
    console.error("listNotebooks: activity scan failed", e);
  }

  function effectiveNotebookActivityMs(nb: (typeof list)[0]): number {
    let ms = Math.max(noteRecencyMs(nb.updatedAt), noteRecencyMs(nb.createdAt));
    if (nb.lastNoteActivityAt) {
      ms = Math.max(ms, noteRecencyMs(nb.lastNoteActivityAt));
    }
    const fromScan = lastNoteActivityMs.get(nb.id);
    if (fromScan !== undefined) ms = Math.max(ms, fromScan);
    return ms;
  }

  const withActivity = list.map((nb) => ({
    nb,
    ms: effectiveNotebookActivityMs(nb),
  }));

  withActivity.sort((a, b) => {
    if (b.ms !== a.ms) return b.ms - a.ms;
    if (a.nb.sortOrder !== b.nb.sortOrder) return a.nb.sortOrder - b.nb.sortOrder;
    return a.nb.name.localeCompare(b.nb.name);
  });

  for (const { nb, ms } of withActivity) {
    if (ms > 0 && nb.lastNoteActivityAt == null) {
      void db
        .collection("notebooks")
        .doc(nb.id)
        .update({
          lastNoteActivityAt: Timestamp.fromMillis(ms),
        })
        .catch(() => {});
    }
  }

  return withActivity.map(({ nb, ms }) => ({
    ...nb,
    lastNoteActivityAt: ms > 0 ? new Date(ms).toISOString() : null,
  }));
}

export async function nextNotebookSortOrder(
  userId: string,
  stackId: string | null
): Promise<number> {
  const snap = await db
    .collection("notebooks")
    .where("userId", "==", userId)
    .get();
  let max = 0;
  for (const doc of snap.docs) {
    const sid = (doc.data().stackId as string | undefined) ?? null;
    if (sid !== stackId) continue;
    const so = (doc.data().sortOrder as number) ?? 0;
    if (so > max) max = so;
  }
  return max + 1;
}

export async function createNotebook(
  userId: string,
  name: string,
  sortOrder: number,
  stackId: string | null = null
) {
  const ref = db.collection("notebooks").doc();
  const now = FieldValue.serverTimestamp();
  await ref.set({
    userId,
    name,
    sortOrder,
    stackId,
    createdAt: now,
    updatedAt: now,
  });
  const snap = await ref.get();
  return notebookFromDoc(snap);
}

export async function getNotebook(userId: string, id: string) {
  const snap = await db.collection("notebooks").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  if (d.userId !== userId) return null;
  return notebookFromDoc(snap);
}

export async function updateNotebook(
  userId: string,
  id: string,
  patch: {
    name?: string;
    sortOrder?: number;
    stackId?: string | null;
  }
) {
  const ref = db.collection("notebooks").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  if (d.userId !== userId) return null;

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (patch.name !== undefined) updates.name = patch.name;

  if (patch.stackId !== undefined) {
    const currentSid = (d.stackId as string | undefined) ?? null;
    const newSid = patch.stackId;
    updates.stackId = newSid;
    if (newSid !== currentSid) {
      updates.sortOrder = await nextNotebookSortOrder(userId, newSid);
    }
  }
  if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;

  await ref.update(updates);
  const after = await ref.get();
  return notebookFromDoc(after);
}

const FIRESTORE_BATCH_LIMIT = 500;

async function deleteAttachmentsForNote(
  userId: string,
  noteId: string,
  deleteBlob: (key: string) => void
) {
  const snap = await db
    .collection("attachments")
    .where("noteId", "==", noteId)
    .get();
  const docs = snap.docs.filter((d) => d.data().userId === userId);
  for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = docs.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const doc of chunk) {
      deleteBlob(doc.data().gcsPath as string);
      batch.delete(doc.ref);
    }
    await batch.commit();
  }
}

export async function deleteNotebookCascade(
  userId: string,
  notebookId: string,
  deleteBlob: (key: string) => void
) {
  const ref = db.collection("notebooks").doc(notebookId);
  const ns = await ref.get();
  if (!ns.exists) return false;
  if (ns.data()!.userId !== userId) return false;

  const notesSnap = await db
    .collection("notes")
    .where("notebookId", "==", notebookId)
    .get();
  for (const doc of notesSnap.docs) {
    if (doc.data().userId !== userId) continue;
    await deleteAttachmentsForNote(userId, doc.id, deleteBlob);
    await doc.ref.delete();
  }
  await ref.delete();
  return true;
}

export async function listNotes(userId: string, notebookId: string) {
  const snap = await db
    .collection("notes")
    .where("notebookId", "==", notebookId)
    .get();
  const list = snap.docs
    .filter((doc) => doc.data().userId === userId)
    .map(noteDocToApi);
  list.sort((a, b) => {
    const ta = Math.max(noteRecencyMs(a.updatedAt), noteRecencyMs(a.createdAt));
    const tb = Math.max(noteRecencyMs(b.updatedAt), noteRecencyMs(b.createdAt));
    if (tb !== ta) return tb - ta;
    return b.id.localeCompare(a.id);
  });
  return list;
}

function noteDocToApi(doc: DocumentSnapshot | QueryDocumentSnapshot) {
  const d = doc.data()!;
  const createdAt = noteTimestampToIso(d.createdAt) ?? NOTE_TIME_EPOCH_ISO;
  const updatedAt = noteTimestampToIso(d.updatedAt) ?? createdAt;
  return {
    id: doc.id,
    notebookId: d.notebookId as string,
    title: (d.title as string) ?? "",
    body: (d.body as string) ?? "",
    bodyText: (d.bodyText as string) ?? "",
    createdAt,
    updatedAt,
    evernoteGuid: (d.evernoteGuid as string | undefined) ?? null,
  };
}

export async function createNote(
  userId: string,
  data: {
    notebookId: string;
    title: string;
    body: string;
    bodyText: string;
    evernoteGuid?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
  },
  opts?: { skipNotebookActivity?: boolean }
) {
  const ref = db.collection("notes").doc();
  const now = Timestamp.now();
  const createdAt = data.createdAt ? Timestamp.fromDate(data.createdAt) : now;
  const updatedAt = data.updatedAt ? Timestamp.fromDate(data.updatedAt) : now;
  const payload: Record<string, unknown> = {
    userId,
    notebookId: data.notebookId,
    title: data.title,
    body: data.body,
    bodyText: data.bodyText,
    createdAt,
    updatedAt,
  };
  if (data.evernoteGuid) payload.evernoteGuid = data.evernoteGuid;
  await ref.set(payload);
  if (!opts?.skipNotebookActivity) {
    const ms = Math.max(createdAt.toMillis(), updatedAt.toMillis());
    await touchNotebookLastNoteActivity(userId, data.notebookId, ms);
  }
  return {
    id: ref.id,
    notebookId: data.notebookId,
    title: data.title,
    body: data.body,
    bodyText: data.bodyText,
    createdAt: tsToIso(createdAt),
    updatedAt: tsToIso(updatedAt),
    evernoteGuid: data.evernoteGuid ?? null,
  };
}

export async function getNote(userId: string, id: string) {
  const snap = await db.collection("notes").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  if (d.userId !== userId) return null;
  return noteDocToApi(snap);
}

export async function updateNote(
  userId: string,
  id: string,
  patch: {
    notebookId?: string;
    title?: string;
    body?: string;
    bodyText?: string;
    updatedAt?: Date;
  },
  opts?: { skipNotebookActivity?: boolean }
) {
  const ref = db.collection("notes").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if (snap.data()!.userId !== userId) return null;
  const oldNotebookId = snap.data()!.notebookId as string;
  const upd: Record<string, unknown> = {
    updatedAt: patch.updatedAt
      ? Timestamp.fromDate(patch.updatedAt)
      : FieldValue.serverTimestamp(),
  };
  if (patch.notebookId !== undefined) upd.notebookId = patch.notebookId;
  if (patch.title !== undefined) upd.title = patch.title;
  if (patch.body !== undefined) upd.body = patch.body;
  if (patch.bodyText !== undefined) upd.bodyText = patch.bodyText;
  await ref.update(upd);
  const after = await ref.get();
  const api = noteDocToApi(after);

  if (!opts?.skipNotebookActivity) {
    const ms = Math.max(noteRecencyMs(api.createdAt), noteRecencyMs(api.updatedAt));
    await touchNotebookLastNoteActivity(userId, api.notebookId, ms);
    if (api.notebookId !== oldNotebookId) {
      await refreshNotebookLastNoteActivityFromNotes(userId, oldNotebookId);
    }
  }

  return api;
}

export async function deleteNote(
  userId: string,
  id: string,
  deleteBlob: (key: string) => void
) {
  const ref = db.collection("notes").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if (snap.data()!.userId !== userId) return false;
  const notebookId = snap.data()!.notebookId as string;
  await deleteAttachmentsForNote(userId, id, deleteBlob);
  await ref.delete();
  await refreshNotebookLastNoteActivityFromNotes(userId, notebookId);
  return true;
}

export async function findNoteByEvernoteGuid(userId: string, guid: string) {
  const snap = await db
    .collection("notes")
    .where("evernoteGuid", "==", guid)
    .limit(20)
    .get();
  for (const doc of snap.docs) {
    if (doc.data().userId === userId) return noteDocToApi(doc);
  }
  return null;
}

export async function createAttachment(
  userId: string,
  data: {
    noteId: string;
    gcsPath: string;
    mimeType: string;
    filename: string;
    sizeBytes: number;
  }
) {
  const ref = db.collection("attachments").doc();
  await ref.set({
    userId,
    noteId: data.noteId,
    gcsPath: data.gcsPath,
    mimeType: data.mimeType,
    filename: data.filename,
    sizeBytes: data.sizeBytes,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
}

export async function getAttachment(userId: string, id: string) {
  const snap = await db.collection("attachments").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  if (d.userId !== userId) return null;
  return {
    id: snap.id,
    gcsPath: d.gcsPath as string,
    mimeType: d.mimeType as string,
    filename: d.filename as string,
  };
}

export async function deleteAttachmentsForNoteId(
  userId: string,
  noteId: string,
  deleteBlob: (key: string) => void
) {
  await deleteAttachmentsForNote(userId, noteId, deleteBlob);
}

export async function createImportJob(data: {
  id: string;
  userId: string;
  gcsStagingKey: string;
  fileName: string;
  notebookId: string | null;
}) {
  const ref = db.collection("importJobs").doc(data.id);
  const now = FieldValue.serverTimestamp();
  await ref.set({
    userId: data.userId,
    status: "pending",
    gcsStagingKey: data.gcsStagingKey,
    fileName: data.fileName,
    notebookId: data.notebookId,
    notesCreated: 0,
    notesSkipped: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  return importJobPublicFromSnap(await ref.get());
}

function importJobPublicFromSnap(snap: DocumentSnapshot) {
  const d = snap.data()!;
  return {
    id: snap.id,
    status: d.status as string,
    notebookId: (d.notebookId as string | null) ?? null,
    fileName: (d.fileName as string | null) ?? null,
    notesCreated: (d.notesCreated as number) ?? 0,
    notesSkipped: (d.notesSkipped as number) ?? 0,
    error: (d.error as string | null) ?? null,
    createdAt: tsToIso(d.createdAt as Timestamp),
    updatedAt: tsToIso(d.updatedAt as Timestamp),
  };
}

export async function getImportJob(id: string) {
  const snap = await db.collection("importJobs").doc(id).get();
  if (!snap.exists) return null;
  return importJobPublicFromSnap(snap);
}

export async function getImportJobInternal(id: string) {
  const snap = await db.collection("importJobs").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  return {
    id: snap.id,
    userId: d.userId as string,
    status: d.status as string,
    notebookId: (d.notebookId as string | null) ?? null,
    gcsStagingKey: d.gcsStagingKey as string,
    fileName: (d.fileName as string | null) ?? null,
    notesCreated: (d.notesCreated as number) ?? 0,
    notesSkipped: (d.notesSkipped as number) ?? 0,
    error: (d.error as string | null) ?? null,
    createdAt: tsToIso(d.createdAt as Timestamp),
    updatedAt: tsToIso(d.updatedAt as Timestamp),
  };
}

export async function updateImportJob(
  id: string,
  patch: Partial<{
    status: string;
    notebookId: string | null;
    notesCreated: number;
    notesSkipped: number;
    error: string | null;
  }>
) {
  await db
    .collection("importJobs")
    .doc(id)
    .update({
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

export async function listImportJobs(userId: string, limit: number) {
  const snap = await db
    .collection("importJobs")
    .where("userId", "==", userId)
    .get();
  const list = snap.docs.map((d) => importJobPublicFromSnap(d));
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list.slice(0, limit);
}

export async function createFeedbackEntry(data: {
  userId: string;
  email: string;
  message: string;
}) {
  const ref = db.collection("feedback").doc();
  await ref.set({
    userId: data.userId,
    email: data.email,
    message: data.message,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function headlineHtml(bodyText: string, term: string): string | null {
  if (!bodyText || !term) return null;
  const lower = bodyText.toLowerCase();
  const t = term.toLowerCase();
  const i = lower.indexOf(t);
  if (i < 0) return null;
  const start = Math.max(0, i - 30);
  const end = Math.min(bodyText.length, i + t.length + 30);
  const before = escapeHtml(bodyText.slice(start, i));
  const mid = escapeHtml(bodyText.slice(i, i + t.length));
  const after = escapeHtml(bodyText.slice(i + t.length, end));
  return before + "<mark>" + mid + "</mark>" + after;
}

export async function searchNotes(userId: string, query: string) {
  const needle = query.toLowerCase().trim();
  const words = needle.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const hits: {
    note: ReturnType<typeof noteDocToApi>;
    rank: number;
    headline: string | null;
  }[] = [];

  const snap = await db
    .collection("notes")
    .where("userId", "==", userId)
    .get();

  for (const doc of snap.docs) {
    const d = doc.data();
    const title = ((d.title as string) ?? "").toLowerCase();
    const bodyText = ((d.bodyText as string) ?? "").toLowerCase();
    const hay = `${title}\n${bodyText}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const note = noteDocToApi(doc);
    const headline = headlineHtml(
      (d.bodyText as string) ?? "",
      words[0] ?? needle
    );
    hits.push({ note, rank: 1, headline });
    if (hits.length >= 50) break;
  }

  return hits;
}
