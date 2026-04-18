/**
 * TipTap task items must parse as:
 *   <li data-type="taskItem"><label>…checkbox…</label><div>…block content…</div></li>
 * inside <ul data-type="taskList">.
 *
 * Imports / AI HTML often omit `data-type` on <li>, wrap everything in one <div>, put the
 * checkbox inside <p>, or leave a bare <input type="checkbox">. Any of those can make the
 * checkbox render above the text. This rewrites the string before setContent().
 */

function normalizeDataTypeAttrs(root: Element) {
  for (const el of root.querySelectorAll("[data-type]")) {
    const v = el.getAttribute("data-type");
    if (!v) continue;
    if (v.toLowerCase() === "tasklist" && v !== "taskList") {
      el.setAttribute("data-type", "taskList");
    }
    if (v.toLowerCase() === "taskitem" && v !== "taskItem") {
      el.setAttribute("data-type", "taskItem");
    }
  }
}

function hasCheckbox(el: Element): boolean {
  return !!el.querySelector('input[type="checkbox"], input[type=checkbox]');
}

/** Checkbox <label> that belongs to this <li> (not a nested task row). */
function findCheckboxLabelForLi(li: Element): HTMLLabelElement | null {
  for (const lab of li.querySelectorAll("label")) {
    if (lab.closest("li") !== li) continue;
    if (lab.querySelector('input[type="checkbox"], input[type=checkbox]')) {
      return lab as HTMLLabelElement;
    }
  }
  return null;
}

/** Wrap direct child checkbox inputs in <label><input><span></span></label> (TipTap shape). */
function wrapBareCheckboxesInLi(li: HTMLElement, doc: Document) {
  const toWrap: HTMLInputElement[] = [];
  for (const child of Array.from(li.children)) {
    if (child.tagName.toLowerCase() !== "input") continue;
    const inp = child as HTMLInputElement;
    if (inp.type !== "checkbox") continue;
    toWrap.push(inp);
  }
  for (const inp of toWrap) {
    const label = doc.createElement("label");
    const span = doc.createElement("span");
    inp.replaceWith(label);
    label.appendChild(inp);
    label.appendChild(span);
  }
}

function ensureTaskListUl(ul: Element) {
  if (ul.tagName.toLowerCase() === "ul" && ul.getAttribute("data-type") !== "taskList") {
    ul.setAttribute("data-type", "taskList");
  }
}

function ensureLiTaskItemAttrs(li: HTMLElement) {
  li.setAttribute("data-type", "taskItem");
  if (!li.hasAttribute("data-checked")) {
    const cb = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    const checked = !!(cb?.checked || cb?.hasAttribute("checked"));
    li.setAttribute("data-checked", checked ? "true" : "false");
  }
}

function ensureContentDivHasBlocks(div: HTMLElement, doc: Document) {
  if (div.querySelector("p, ul, ol, h1, h2, h3, h4, blockquote, pre, li, table")) {
    return;
  }
  const p = doc.createElement("p");
  while (div.firstChild) {
    p.appendChild(div.firstChild);
  }
  div.appendChild(p);
}

function normalizeOneTaskItemLi(li: HTMLElement, doc: Document) {
  wrapBareCheckboxesInLi(li, doc);

  const label = findCheckboxLabelForLi(li);
  if (!label) return;

  label.remove();
  li.insertBefore(label, li.firstChild);

  const toMove: Node[] = [];
  let n: ChildNode | null = label.nextSibling;
  while (n) {
    const next = n.nextSibling;
    toMove.push(n);
    n = next;
  }

  if (toMove.length === 0) {
    const div = doc.createElement("div");
    div.appendChild(doc.createElement("p"));
    li.appendChild(div);
    return;
  }

  if (toMove.length === 1 && toMove[0]!.nodeType === Node.ELEMENT_NODE) {
    const el = toMove[0] as HTMLElement;
    if (el.tagName.toLowerCase() === "div") {
      ensureContentDivHasBlocks(el, doc);
      li.appendChild(el);
      return;
    }
  }

  const wrap = doc.createElement("div");
  for (const node of toMove) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      wrap.appendChild(node);
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      const p = doc.createElement("p");
      p.appendChild(node);
      wrap.appendChild(p);
    } else {
      node.parentNode?.removeChild(node);
    }
  }
  ensureContentDivHasBlocks(wrap, doc);
  li.appendChild(wrap);
}

function collectTaskLisToNormalize(root: Element): HTMLElement[] {
  const out = new Set<HTMLElement>();

  for (const li of root.querySelectorAll("li[data-type='taskItem']")) {
    out.add(li as HTMLElement);
  }

  for (const ul of root.querySelectorAll("ul[data-type='taskList']")) {
    for (const child of Array.from(ul.children)) {
      if (child.tagName.toLowerCase() !== "li") continue;
      if (hasCheckbox(child)) {
        out.add(child as HTMLElement);
      }
    }
  }

  // Plain <ul> whose items look like checklists (no TipTap attrs) — e.g. imports
  for (const ul of root.querySelectorAll("ul:not([data-type])")) {
    const lis = Array.from(ul.children).filter((c) => c.tagName.toLowerCase() === "li");
    if (lis.length === 0) continue;
    const allCheckboxy = lis.every((li) => hasCheckbox(li));
    if (!allCheckboxy) continue;
    ensureTaskListUl(ul);
    for (const li of lis) {
      out.add(li as HTMLElement);
    }
  }

  return [...out];
}

export function normalizeTaskListHtmlForEditor(html: string): string {
  if (typeof document === "undefined") return html;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="root">${html}</div>`, "text/html");
    const root = doc.querySelector("#root");
    if (!root) return html;

    normalizeDataTypeAttrs(root);

    for (const li of collectTaskLisToNormalize(root)) {
      const ul = li.parentElement;
      if (ul?.tagName.toLowerCase() === "ul") {
        ensureTaskListUl(ul);
      }
      ensureLiTaskItemAttrs(li);
      normalizeOneTaskItemLi(li, doc);
    }

    return root.innerHTML;
  } catch {
    return html;
  }
}
