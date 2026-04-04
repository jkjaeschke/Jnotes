import type { NoteAiSummary } from "../data/store.js";

export type NotebookStub = { id: string; name: string };

export type OrganizeSuggestion = {
  noteId: string;
  suggestedNotebookId: string;
  reason: string;
  confidence: number;
};

function tokens(s: string): Set<string> {
  const set = new Set<string>();
  for (const w of s
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((x) => x.length > 1)) {
    set.add(w);
  }
  return set;
}

function overlapScore(noteText: string, notebookName: string): number {
  const nt = tokens(noteText);
  const nn = tokens(notebookName);
  if (nn.size === 0) return 0;
  let hit = 0;
  for (const t of nn) {
    if (nt.has(t)) hit += 1;
  }
  const j = hit / nn.size;
  const contains = notebookName.length > 2 && noteText.toLowerCase().includes(notebookName.toLowerCase());
  return Math.min(1, j * 0.85 + (contains ? 0.25 : 0));
}

export function suggestNotebookMoves(
  notes: NoteAiSummary[],
  notebooks: NotebookStub[]
): OrganizeSuggestion[] {
  const nbById = new Map(notebooks.map((n) => [n.id, n]));
  const out: OrganizeSuggestion[] = [];
  for (const note of notes) {
    const hay = `${note.title}\n${note.bodyText}`.slice(0, 16_000);
    let bestId = note.notebookId;
    let best = 0;
    for (const nb of notebooks) {
      if (nb.id === note.notebookId) continue;
      const s = overlapScore(hay, nb.name);
      if (s > best) {
        best = s;
        bestId = nb.id;
      }
    }
    if (bestId === note.notebookId || best < 0.12) continue;
    const target = nbById.get(bestId);
    if (!target) continue;
    out.push({
      noteId: note.id,
      suggestedNotebookId: bestId,
      confidence: Math.round(best * 100) / 100,
      reason: `Notebook “${target.name}” matches words in this note’s title or body.`,
    });
  }
  return out;
}
