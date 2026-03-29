const LEGACY_NOTEBOOK = "freenotes:lastNotebookId";
const LEGACY_NOTE = "freenotes:lastNoteId";

function keyNotebook(userId: string) {
  return `freenotes:u:${userId}:lastNotebookId`;
}

function keyNote(userId: string) {
  return `freenotes:u:${userId}:lastNoteId`;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore quota / private mode */
  }
}

/** One-time migration from pre–per-user keys. */
function migrateLegacyNotebook(userId: string): void {
  const legacy = safeGet(LEGACY_NOTEBOOK);
  if (!legacy) return;
  if (!safeGet(keyNotebook(userId))) {
    safeSet(keyNotebook(userId), legacy);
  }
  safeSet(LEGACY_NOTEBOOK, null);
}

function migrateLegacyNote(userId: string): void {
  const legacy = safeGet(LEGACY_NOTE);
  if (!legacy) return;
  if (!safeGet(keyNote(userId))) {
    safeSet(keyNote(userId), legacy);
  }
  safeSet(LEGACY_NOTE, null);
}

export function readLastNotebookId(userId: string): string | null {
  migrateLegacyNotebook(userId);
  return safeGet(keyNotebook(userId));
}

export function writeLastNotebookId(userId: string, id: string | null) {
  safeSet(keyNotebook(userId), id);
}

export function readLastNoteId(userId: string): string | null {
  migrateLegacyNote(userId);
  return safeGet(keyNote(userId));
}

export function writeLastNoteId(userId: string, id: string | null) {
  safeSet(keyNote(userId), id);
}
