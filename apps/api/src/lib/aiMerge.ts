function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildMergedNotesHtml(
  notes: { id: string; title: string; body: string }[]
): { mergedHtml: string; warnings: string[] } {
  const warnings: string[] = [];
  const sections: string[] = [];
  for (const n of notes) {
    const title = (n.title || "Untitled").trim() || "Untitled";
    const body = (n.body || "").trim() || "<p></p>";
    sections.push(
      `<section data-merged-note="1" data-note-id="${escapeAttr(n.id)}"><p><em>${escapeAttr(
        title
      )}</em></p>${body}</section>`
    );
  }
  if (notes.length > 1) {
    warnings.push(
      "Images and attachments from merged notes still point at their original note URLs until you re-upload if needed."
    );
  }
  return { mergedHtml: sections.join("<hr />"), warnings };
}
