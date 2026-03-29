const KEY_NOTEBOOK = "freenotes:lastNotebookId";
const KEY_NOTE = "freenotes:lastNoteId";

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

export function readLastNotebookId(): string | null {
  return safeGet(KEY_NOTEBOOK);
}

export function writeLastNotebookId(id: string | null) {
  safeSet(KEY_NOTEBOOK, id);
}

export function readLastNoteId(): string | null {
  return safeGet(KEY_NOTE);
}

export function writeLastNoteId(id: string | null) {
  safeSet(KEY_NOTE, id);
}
