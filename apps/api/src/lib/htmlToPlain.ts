import { convert } from "html-to-text";

export function htmlToPlainText(html: string): string {
  if (!html?.trim()) return "";
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim();
}
