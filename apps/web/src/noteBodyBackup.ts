const PREFIX = "freenotes_note_body_backup::";
const MAX_STORE_CHARS = 1_200_000;

export type NoteBodyBackup = {
  body: string;
  title: string;
  savedAt: string;
};

function key(userId: string, noteId: string): string {
  return `${PREFIX}${userId}::${noteId}`;
}

/** After stripping markup, is this note meaningfully empty? */
export function isTrivialEmptyHtml(html: string): boolean {
  if (!html || !html.trim()) return true;
  const t = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2) return true;
  if (/^[\s\u00a0]*$/.test(t)) return true;
  return t.length < 8;
}

export function readNoteBodyBackup(
  userId: string,
  noteId: string
): NoteBodyBackup | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(userId, noteId));
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<NoteBodyBackup>;
    if (typeof j.body !== "string" || typeof j.savedAt !== "string") return null;
    return {
      body: j.body,
      title: typeof j.title === "string" ? j.title : "",
      savedAt: j.savedAt,
    };
  } catch {
    return null;
  }
}

export function writeNoteBodyBackup(
  userId: string,
  noteId: string,
  title: string,
  body: string
): void {
  if (typeof window === "undefined") return;
  let storeBody = body;
  if (storeBody.length > MAX_STORE_CHARS) {
    storeBody = storeBody.slice(0, MAX_STORE_CHARS);
  }
  try {
    const entry: NoteBodyBackup = {
      body: storeBody,
      title,
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(key(userId, noteId), JSON.stringify(entry));
  } catch {
    // Quota or private mode; ignore
  }
}

export function clearNoteBodyBackup(userId: string, noteId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(userId, noteId));
  } catch {
    // ignore
  }
}
