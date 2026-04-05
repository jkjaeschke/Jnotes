/**
 * Align before/after plain text so line-based diffs match human intent: list markers, spacing,
 * and blank lines from html-to-text often differ between TipTap HTML and model HTML even when the
 * visible sentence is the same aside from small edits.
 */
export function normalizePlainTextForDiff(text: string): string {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = s.split("\n");
  const normalized: string[] = [];
  let prevBlank = false;

  for (let raw of lines) {
    let line = raw.replace(/[\t\f\v]+/g, " ");
    line = line.replace(/ {2,}/g, " ");
    line = line.trim();

    if (line.length === 0) {
      if (!prevBlank) normalized.push("");
      prevBlank = true;
      continue;
    }
    prevBlank = false;

    // Unify common bullet prefixes so "* x" and " * x" / "• x" compare as one line shape
    const bullet = line.match(/^(\*|\u2022|\u25CF|-)\s+(.*)$/u);
    if (bullet) {
      normalized.push(`* ${bullet[2]}`);
      continue;
    }

    normalized.push(line);
  }

  return normalized.join("\n").trim();
}
