import type { NoteAiSummary } from "../data/store.js";

function words(s: string): Set<string> {
  const set = new Set<string>();
  const lower = s.toLowerCase();
  const parts = lower.split(/[^a-z0-9]+/u);
  for (const w of parts) {
    if (w.length > 1) set.add(w);
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

function titleScore(a: string, b: string): number {
  const ta = words(a);
  const tb = words(b);
  return jaccard(ta, tb);
}

function bodyScore(a: string, b: string): number {
  const slice = 12_000;
  return jaccard(words(a.slice(0, slice)), words(b.slice(0, slice)));
}

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
    const ts = titleScore(source.title, c.title);
    const bs = bodyScore(source.bodyText, c.bodyText);
    const score = Math.min(1, 0.45 * ts + 0.55 * bs);
    if (score < 0.03) continue;
    const reasons: string[] = [];
    if (ts > 0.15) reasons.push("Similar title words");
    if (bs > 0.08) reasons.push("Overlapping note text");
    if (reasons.length === 0) reasons.push("Loose text overlap");
    out.push({ id: c.id, score, reason: reasons.join("; ") });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(limit, 50)));
}
