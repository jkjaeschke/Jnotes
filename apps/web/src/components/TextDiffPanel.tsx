import { diffLines } from "diff";
import { normalizePlainTextForDiff } from "../diffPlainText.js";

type Props = {
  before: string;
  after: string;
  className?: string;
};

export function TextDiffPanel({ before, after, className }: Props) {
  const parts = diffLines(
    normalizePlainTextForDiff(before),
    normalizePlainTextForDiff(after)
  );
  return (
    <div
      className={className ? `text-diff-panel ${className}` : "text-diff-panel"}
      role="region"
      aria-label="Text changes"
    >
      {parts.map((part, i) => {
        const rowClass = part.added
          ? "text-diff-row text-diff-added"
          : part.removed
            ? "text-diff-row text-diff-removed"
            : "text-diff-row text-diff-unchanged";
        return (
          <div key={i} className={rowClass}>
            {part.value}
          </div>
        );
      })}
    </div>
  );
}
