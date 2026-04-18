/**
 * Make model HTML render like TipTap output in static previews (modal columns).
 * - LLM often emits `<li data-type="taskItem">` without a checkbox `<label>` — sometimes inside a
 *   plain `<ul>` (not `data-type="taskList"`). Global task-item layout in the editor uses CSS grid
 *   on `li`; orphan fake items still need attrs stripped.
 * - Strip bogus task-list attrs when no real TipTap task UI (`label` first in `li`).
 * - Remove empty / br-only `<p>` and `<div>` (LLM spacing junk).
 * - Merge leading inline nodes into the first `<p>` inside `<li>`.
 */
export function normalizeNoteHtmlForPreview(html: string): string {
  if (typeof document === "undefined") return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.querySelector("#root");
  if (!root) return html;

  stripBogusTaskLists(root);
  stripBogusTaskItemAttrs(root);
  removeEmptyPlaceholderBlocks(root);
  mergeLeadingNodesIntoFirstParagraphInListItems(root, doc);

  return root.innerHTML;
}

/** `ul[data-type="taskList"]` with no checkbox labels → plain bullet list. */
function stripBogusTaskLists(root: HTMLElement) {
  for (const ul of Array.from(root.querySelectorAll("ul[data-type='taskList']"))) {
    const directLis = Array.from(ul.children).filter(
      (c) => c.tagName.toLowerCase() === "li"
    );
    const anyCheckbox = directLis.some(
      (li) => li.firstElementChild?.tagName.toLowerCase() === "label"
    );
    if (anyCheckbox) continue;
    ul.removeAttribute("data-type");
    for (const li of directLis) {
      if (li.getAttribute("data-type") === "taskItem") {
        li.removeAttribute("data-type");
        li.removeAttribute("data-checked");
      }
    }
  }
}

/**
 * Orphan `li[data-type="taskItem"]` under a normal `<ul>` / `<ol>` (no typed task list) still
 * matches task-item layout rules and breaks bullets.
 */
function stripBogusTaskItemAttrs(root: HTMLElement) {
  for (const li of root.querySelectorAll("li[data-type='taskItem']")) {
    if (li.firstElementChild?.tagName.toLowerCase() === "label") continue;
    li.removeAttribute("data-type");
    li.removeAttribute("data-checked");
  }
}

function isEmptyBlock(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "p" && tag !== "div") return false;
  const t = el.textContent?.replace(/\u00a0/g, " ").trim() ?? "";
  if (t.length > 0) return false;
  return !el.querySelector("img, svg, iframe");
}

/** Drop empty and `<br>`-only blocks (not inside pre/code). Repeat until stable. */
function removeEmptyPlaceholderBlocks(root: HTMLElement) {
  for (let pass = 0; pass < 48; pass += 1) {
    let removed = false;
    for (const el of Array.from(root.querySelectorAll("p, div"))) {
      if (el.closest("pre, code")) continue;
      if (!isEmptyBlock(el)) continue;
      el.parentNode?.removeChild(el);
      removed = true;
    }
    if (!removed) break;
  }
}

function mergeLeadingNodesIntoFirstParagraphInListItems(
  root: HTMLElement,
  doc: Document
) {
  const items = root.querySelectorAll("ul > li, ol > li");
  for (const li of items) {
    if (li.getAttribute("data-type") === "taskItem") continue;
    const children = Array.from(li.childNodes);
    const firstPIdx = children.findIndex(
      (n) =>
        n.nodeType === Node.ELEMENT_NODE &&
        (n as Element).tagName.toLowerCase() === "p"
    );
    if (firstPIdx <= 0) continue;
    const p = children[firstPIdx] as HTMLParagraphElement;
    const frag = doc.createDocumentFragment();
    for (let i = 0; i < firstPIdx; i++) {
      const n = li.firstChild;
      if (!n) break;
      frag.appendChild(n);
    }
    p.insertBefore(frag, p.firstChild);
  }
}
