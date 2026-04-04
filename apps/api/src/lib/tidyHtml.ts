import { Window } from "happy-dom";

const MAX_INPUT_CHARS = 1_500_000;

/** happy-dom `Element` is not assignable to DOM `Element` under TypeScript; treat as a minimal shape. */
function isEmptyBlock(el: {
  tagName: string;
  textContent: string | null;
  querySelector: (selectors: string) => unknown;
}): boolean {
  const tag = el.tagName.toLowerCase();
  if (!["P", "DIV", "SECTION", "ARTICLE"].includes(tag)) return false;
  const text = el.textContent?.replace(/\u00a0/g, " ").trim() ?? "";
  if (text.length > 0) return false;
  const meaningful = el.querySelector(
    "img, video, audio, iframe, svg, canvas, table, ul, ol, li, blockquote, pre, code"
  );
  return !meaningful;
}

const INVISIBLE_JUNK = /[\u200B-\u200D\uFEFF]/g;

function normalizedVisibleText(el: { textContent: string | null }): string {
  return (el.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(INVISIBLE_JUNK, "")
    .trim();
}

type ElLike = {
  tagName: string;
  textContent: string | null;
  querySelector: (selectors: string) => unknown | null;
  querySelectorAll: (selectors: string) => Iterable<unknown>;
  // happy-dom / DOM `removeChild` typings differ from strict ElLike; keep loose for tidy only.
  parentNode: { removeChild: (n: unknown) => unknown } | null;
};

/** True when the list item has no visible text and no meaningful embedded content. */
function isEmptyListItem(li: ElLike): boolean {
  if (li.tagName.toLowerCase() !== "li") return false;
  if (normalizedVisibleText(li).length > 0) return false;
  if (
    li.querySelector(
      "img, video, audio, iframe, svg, canvas, table, pre, code, input, textarea, select"
    )
  ) {
    return false;
  }
  const link = li.querySelector("a[href]") as { getAttribute?: (n: string) => string | null } | null;
  const href = link?.getAttribute?.("href")?.trim() ?? "";
  if (href.length > 0) return false;

  for (const n of li.querySelectorAll("ul li, ol li")) {
    if (!isEmptyListItem(n as ElLike)) return false;
  }
  return true;
}

function removeEmptyListItems(body: ElLike) {
  for (let pass = 0; pass < 48; pass += 1) {
    const lis = Array.from(body.querySelectorAll("li")) as ElLike[];
    let removed = false;
    for (const li of lis) {
      if (isEmptyListItem(li)) {
        li.parentNode?.removeChild(li);
        removed = true;
      }
    }
    if (!removed) break;
  }
}

function removeEmptyLists(body: ElLike) {
  for (let pass = 0; pass < 24; pass += 1) {
    const lists = Array.from(body.querySelectorAll("ul, ol")) as ElLike[];
    let removed = false;
    for (const list of lists) {
      if (!list.querySelector("li")) {
        list.parentNode?.removeChild(list);
        removed = true;
      }
    }
    if (!removed) break;
  }
}

/** Remove zero-width spaces / BOM from text nodes (common in Slack, Notion, Word paste). */
function stripInvisibleFromTextNodes(node: {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<unknown>;
}): void {
  if (node.nodeType === 3) {
    const t = node.textContent ?? "";
    const cleaned = t.replace(INVISIBLE_JUNK, "");
    if (cleaned !== t) (node as { textContent: string }).textContent = cleaned;
    return;
  }
  for (const child of Array.from(node.childNodes)) {
    if (child && typeof child === "object" && "nodeType" in (child as object))
      stripInvisibleFromTextNodes(child as typeof node);
  }
}

/**
 * Deterministic cleanup: strip invisible paste characters, remove empty blocks and empty list items,
 * drop empty `<ul>`/`<ol>`, collapse redundant `<br>`.
 * It does **not** turn plain lines into headings/lists or rewrite structure — only fixes HTML noise.
 */
export function tidyHtml(html: string): string {
  const raw = html ?? "";
  if (raw.length > MAX_INPUT_CHARS) {
    throw new Error(`HTML exceeds ${MAX_INPUT_CHARS} characters`);
  }

  const window = new Window({ url: "https://localhost/" });
  const document = window.document;
  document.body.innerHTML = raw || "<p></p>";

  for (let pass = 0; pass < 24; pass += 1) {
    const candidates = Array.from(
      document.body.querySelectorAll("p, div, section, article")
    );
    let removed = false;
    for (const el of candidates) {
      if (isEmptyBlock(el)) {
        el.parentNode?.removeChild(el);
        removed = true;
      }
    }
    if (!removed) break;
  }

  const brs = Array.from(document.querySelectorAll("br"));
  for (const br of brs) {
    let prev = br.previousSibling;
    while (prev && prev.nodeType === 3 && !(prev.textContent ?? "").trim()) {
      prev = prev.previousSibling;
    }
    if (prev && prev.nodeName === "BR") {
      br.parentNode?.removeChild(br);
    }
  }

  for (const p of Array.from(document.querySelectorAll("p"))) {
    const inner = p.innerHTML.replace(/^(<br\s*\/?>)+/i, "").replace(/(<br\s*\/?>)+$/i, "");
    if (inner !== p.innerHTML) p.innerHTML = inner;
  }

  stripInvisibleFromTextNodes(document.body);

  removeEmptyListItems(document.body as ElLike);
  removeEmptyLists(document.body as ElLike);

  let out = document.body.innerHTML;
  out = out.replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br><br>");
  return out.trim() || "<p></p>";
}
