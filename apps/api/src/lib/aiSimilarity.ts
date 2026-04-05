import type { NoteAiSummary } from "../data/store.js";

/** English stopwords — excluded so Jaccard reflects topical overlap, not boilerplate. */
const STOPWORDS = new Set(
  "a about above after again against all am an and any are as at be because been before being below between both but by could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves".split(
    /\s+/u
  )
);

function tokenizeMeaningful(s: string): Set<string> {
  const set = new Set<string>();
  const lower = s.toLowerCase();
  const parts = lower.split(/[^a-z0-9]+/u);
  for (const w of parts) {
    if (w.length < 2) continue;
    if (STOPWORDS.has(w)) continue;
    set.add(w);
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export function isGenericTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (t.length === 0) return true;
  return /^(untitled(\s+note)?|new\s+note|note\s*)$/.test(t);
}

/** True when the note has no meaningful body (merge/consolidate should not treat it as content). */
export function isEmptyNoteBody(bodyText: string): boolean {
  const t = bodyText.replace(/\s+/g, " ").trim();
  if (t.length === 0) return true;
  if (t.length < 20 && /^write your note/i.test(t)) return true;
  return t.length < 12;
}

function titleSimilarity(a: string, b: string): number {
  if (isGenericTitle(a) && isGenericTitle(b)) return 0;
  return jaccard(tokenizeMeaningful(a), tokenizeMeaningful(b));
}

function bodySimilarity(a: string, b: string): number {
  const slice = 14_000;
  return jaccard(
    tokenizeMeaningful(a.slice(0, slice)),
    tokenizeMeaningful(b.slice(0, slice))
  );
}

const MIN_SCORE = 0.16;
const BODY_ENOUGH = 0.1;
const TITLE_ENOUGH = 0.28;

export type SimilarCandidate = {
  id: string;
  score: number;
  reason: string;
};

export function rankSimilarNotes(
  source: NoteAiSummary,
  candidates: NoteAiSummary[],
  limit: number
): SimilarCandidate[] {
  const out: SimilarCandidate[] = [];
  for (const c of candidates) {
    if (c.id === source.id) continue;
    if (isEmptyNoteBody(c.bodyText)) continue;

    const ts = titleSimilarity(source.title, c.title);
    const bs = bodySimilarity(source.bodyText, c.bodyText);

    const bothGenericTitles = isGenericTitle(source.title) && isGenericTitle(c.title);
    if (bothGenericTitles && bs < BODY_ENOUGH) continue;

    if (!bothGenericTitles && ts < TITLE_ENOUGH && bs < BODY_ENOUGH) continue;

    let score: number;
    if (bothGenericTitles) {
      score = bs;
    } else {
      score = Math.min(1, 0.22 * ts + 0.78 * bs);
    }

    if (score < MIN_SCORE) continue;

    const reasons: string[] = [];
    if (ts >= TITLE_ENOUGH) reasons.push("Similar title");
    if (bs >= BODY_ENOUGH) reasons.push("Similar note content");
    if (reasons.length === 0) reasons.push("Related content");
    out.push({ id: c.id, score, reason: reasons.join(" · ") });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.min(limit, 50));
}
