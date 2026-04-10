import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

type TextStyleAttrs = {
  fontFamily?: string | null;
  fontSize?: string | null;
  color?: string | null;
};

type ToolbarSelectionSnap = { from: number; to: number };

/** Remember non-empty selection when the user mousedowns on a toolbar control (before focus leaves the editor). */
function captureToolbarSelectionSnap(
  editor: Editor,
  snapRef: MutableRefObject<ToolbarSelectionSnap | null>
) {
  const { from, to } = editor.state.selection;
  snapRef.current = from !== to ? { from, to } : null;
}

/** If the editor selection was collapsed by focusing the toolbar, restore the snap before running a command. */
function consumeToolbarSelectionSnap(
  editor: Editor,
  snapRef: MutableRefObject<ToolbarSelectionSnap | null>
) {
  const snap = snapRef.current;
  snapRef.current = null;
  if (!snap || snap.from >= snap.to) return;
  if (!editor.state.selection.empty) return;
  const docSize = editor.state.doc.content.size;
  const from = Math.max(0, Math.min(snap.from, docSize));
  const to = Math.max(0, Math.min(snap.to, docSize));
  if (from >= to) return;
  editor.chain().focus().setTextSelection({ from, to }).run();
}

/** textStyle attrs at a document position (caret is collapsed after toolbar focus — getAttributes is wrong for merge). */
function textStyleAttrsAtPos(editor: Editor, pos: number): TextStyleAttrs {
  const doc = editor.state.doc;
  const size = doc.content.size;
  const p = Math.max(0, Math.min(pos, size));
  const $pos = doc.resolve(p);
  const marks = editor.state.storedMarks ?? $pos.marks();
  const ts = marks.find((m) => m.type.name === "textStyle");
  return (ts?.attrs ?? {}) as TextStyleAttrs;
}

function mergeTextStyle(
  editor: Editor,
  snapRef: MutableRefObject<ToolbarSelectionSnap | null>,
  patch: Partial<TextStyleAttrs>
) {
  const snap = snapRef.current;
  snapRef.current = null;

  const sel = editor.state.selection;
  const prev: TextStyleAttrs =
    snap && sel.empty
      ? textStyleAttrsAtPos(editor, snap.from)
      : (editor.getAttributes("textStyle") as TextStyleAttrs);

  const next: Record<string, string | null> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") {
      delete next[k];
    } else {
      next[k] = v;
    }
  }
  const hasAttrs = Object.keys(next).some((key) => {
    const val = next[key];
    return val != null && val !== "";
  });
  if (!hasAttrs) {
    if (snap && sel.empty && snap.from < snap.to) {
      const docSize = editor.state.doc.content.size;
      const from = Math.max(0, Math.min(snap.from, docSize));
      const to = Math.max(0, Math.min(snap.to, docSize));
      if (from < to) {
        editor.chain().focus().setTextSelection({ from, to }).unsetMark("textStyle").run();
        return;
      }
    }
    editor.chain().focus().unsetMark("textStyle").run();
    return;
  }

  let chain = editor.chain().focus();
  if (snap && sel.empty && snap.from < snap.to) {
    const docSize = editor.state.doc.content.size;
    const from = Math.max(0, Math.min(snap.from, docSize));
    const to = Math.max(0, Math.min(snap.to, docSize));
    if (from < to) {
      chain = chain.setTextSelection({ from, to });
    }
  }
  const attrsForMark: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v != null && v !== "") attrsForMark[k] = v;
  }
  // Do not chain removeEmptyTextStyle here — it can strip the mark in the same transaction as setMark.
  chain.setMark("textStyle", attrsForMark).run();
}

function blockValue(editor: Editor | null): string {
  if (!editor) return "paragraph";
  if (editor.isActive("heading", { level: 1 })) return "h1";
  if (editor.isActive("heading", { level: 2 })) return "h2";
  if (editor.isActive("heading", { level: 3 })) return "h3";
  return "paragraph";
}

function currentAlign(editor: Editor | null): "left" | "center" | "right" | "justify" {
  if (!editor) return "left";
  const order: Array<"left" | "center" | "right" | "justify"> = [
    "left",
    "center",
    "right",
    "justify",
  ];
  for (const a of order) {
    if (editor.isActive({ textAlign: a })) return a;
  }
  return "left";
}

/**
 * Office-friendly faces first (Calibri/Cambria need local install — typical on Windows + Microsoft 365).
 * Values are full stacks so selection still looks reasonable on macOS/Linux without those fonts.
 */
const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Default", value: "" },
  {
    label: "Calibri",
    value:
      'Calibri, "Candara", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    label: "Cambria",
    value: 'Cambria, "Times New Roman", "Liberation Serif", Georgia, serif',
  },
  {
    label: "Segoe UI",
    value: '"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  {
    label: "Times New Roman",
    value: '"Times New Roman", Times, "Liberation Serif", serif',
  },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Sans serif", value: "ui-sans-serif, system-ui, sans-serif" },
  { label: "Serif", value: "ui-serif, Georgia, serif" },
  { label: "Monospace", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
];

const SIZE_OPTIONS: { label: string; value: string }[] = [
  { label: "Default", value: "" },
  { label: "12", value: "12px" },
  { label: "14", value: "14px" },
  { label: "15", value: "15px" },
  { label: "16", value: "16px" },
  { label: "18", value: "18px" },
  { label: "20", value: "20px" },
  { label: "24", value: "24px" },
];

const HIGHLIGHT_COLORS = ["#fef08a", "#bbf7d0", "#fecaca", "#bfdbfe", "#e9d5ff"];

type Props = {
  editor: Editor | null;
};

export function NoteEditorToolbar({ editor }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const toolbarSelectionSnapRef = useRef<ToolbarSelectionSnap | null>(null);

  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) {
        return {
          canUndo: false,
          canRedo: false,
          isBold: false,
          isItalic: false,
          isUnderline: false,
          isStrike: false,
          isSubscript: false,
          isSuperscript: false,
          isBulletList: false,
          isOrderedList: false,
          isTaskList: false,
          block: "paragraph" as const,
          align: "left" as const,
          fontFamily: "",
          fontSize: "",
          color: "#111827",
        };
      }
      const ts = ed.getAttributes("textStyle") as TextStyleAttrs;
      return {
        canUndo: ed.can().undo(),
        canRedo: ed.can().redo(),
        isBold: ed.isActive("bold"),
        isItalic: ed.isActive("italic"),
        isUnderline: ed.isActive("underline"),
        isStrike: ed.isActive("strike"),
        isSubscript: ed.isActive("subscript"),
        isSuperscript: ed.isActive("superscript"),
        isBulletList: ed.isActive("bulletList"),
        isOrderedList: ed.isActive("orderedList"),
        isTaskList: ed.isActive("taskList"),
        block: blockValue(ed),
        align: currentAlign(ed),
        fontFamily: ts.fontFamily ?? "",
        fontSize: ts.fontSize ?? "",
        color: ts.color ?? "#111827",
      };
    },
  });

  useEffect(() => {
    if (!moreOpen && !highlightOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = moreRef.current;
      if (el && !el.contains(e.target as Node)) {
        setMoreOpen(false);
        setHighlightOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen, highlightOpen]);

  /** Drop toolbar snap when clicking in the note body so a cancelled dropdown cannot revive an old range. */
  useEffect(() => {
    const root = editor?.view?.dom;
    if (!root) return;
    const onCap = (e: MouseEvent) => {
      if (root.contains(e.target as Node)) toolbarSelectionSnapRef.current = null;
    };
    document.addEventListener("mousedown", onCap, true);
    return () => document.removeEventListener("mousedown", onCap, true);
  }, [editor]);

  const setBlock = useCallback(
    (value: string) => {
      if (!editor) return;
      consumeToolbarSelectionSnap(editor, toolbarSelectionSnapRef);
      const chain = editor.chain().focus();
      if (value === "paragraph") chain.setParagraph().run();
      else if (value === "h1") chain.setHeading({ level: 1 }).run();
      else if (value === "h2") chain.setHeading({ level: 2 }).run();
      else if (value === "h3") chain.setHeading({ level: 3 }).run();
    },
    [editor]
  );

  const captureToolbarSnap = useCallback(() => {
    if (editor) captureToolbarSelectionSnap(editor, toolbarSelectionSnapRef);
  }, [editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    const t = url.trim();
    if (t === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: t }).run();
  }, [editor]);

  const sinkList = useCallback(() => {
    if (!editor) return;
    if (editor.can().sinkListItem("taskItem")) {
      editor.chain().focus().sinkListItem("taskItem").run();
    } else {
      editor.chain().focus().sinkListItem("listItem").run();
    }
  }, [editor]);

  const liftList = useCallback(() => {
    if (!editor) return;
    if (editor.can().liftListItem("taskItem")) {
      editor.chain().focus().liftListItem("taskItem").run();
    } else {
      editor.chain().focus().liftListItem("listItem").run();
    }
  }, [editor]);

  if (!editor) {
    return null;
  }

  const fontSelectValue = FONT_OPTIONS.some((o) => o.value === state.fontFamily)
    ? state.fontFamily
    : "";
  const sizeSelectValue = SIZE_OPTIONS.some((o) => o.value === state.fontSize)
    ? state.fontSize
    : "";

  return (
    <div className="editor-format-toolbar" ref={moreRef}>
      <div className="editor-toolbar-group">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Undo"
          disabled={!state.canUndo}
          onClick={() => editor.chain().focus().undo().run()}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Redo"
          disabled={!state.canRedo}
          onClick={() => editor.chain().focus().redo().run()}
        >
          ↷
        </button>
      </div>

      <div className="editor-toolbar-group">
        <label className="sr-only" htmlFor="note-block-style">
          Paragraph style
        </label>
        <select
          id="note-block-style"
          className="input editor-toolbar-select"
          value={state.block}
          onMouseDown={captureToolbarSnap}
          onChange={(e) => setBlock(e.target.value)}
        >
          <option value="paragraph">Normal</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>
      </div>

      <div className="editor-toolbar-group">
        <label className="sr-only" htmlFor="note-font-family">
          Font
        </label>
        <select
          id="note-font-family"
          className="input editor-toolbar-select editor-toolbar-select-font"
          value={fontSelectValue}
          onMouseDown={captureToolbarSnap}
          onChange={(e) => {
            const v = e.target.value;
            mergeTextStyle(editor, toolbarSelectionSnapRef, { fontFamily: v || null });
          }}
        >
          {FONT_OPTIONS.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="editor-toolbar-group">
        <label className="sr-only" htmlFor="note-font-size">
          Size
        </label>
        <select
          id="note-font-size"
          className="input editor-toolbar-select editor-toolbar-select-narrow"
          value={sizeSelectValue}
          onMouseDown={captureToolbarSnap}
          onChange={(e) => {
            const v = e.target.value;
            mergeTextStyle(editor, toolbarSelectionSnapRef, { fontSize: v || null });
          }}
        >
          {SIZE_OPTIONS.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="editor-toolbar-group editor-toolbar-color">
        <label className="sr-only" htmlFor="note-text-color">
          Text color
        </label>
        <input
          id="note-text-color"
          type="color"
          className="editor-color-swatch"
          value={/^#[0-9a-fA-F]{6}$/.test(state.color) ? state.color : "#111827"}
          onMouseDown={captureToolbarSnap}
          onChange={(e) =>
            mergeTextStyle(editor, toolbarSelectionSnapRef, { color: e.target.value })
          }
          aria-label="Text color"
        />
      </div>

      <div className="editor-toolbar-group">
        <button
          type="button"
          className={`btn btn-ghost btn-icon${state.isBold ? " is-active" : ""}`}
          aria-label="Bold"
          aria-pressed={state.isBold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          className={`btn btn-ghost btn-icon${state.isItalic ? " is-active" : ""}`}
          aria-label="Italic"
          aria-pressed={state.isItalic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </button>
      </div>

      <div className="editor-toolbar-group editor-toolbar-more-wrap">
        <button
          type="button"
          className={`btn btn-ghost${moreOpen ? " is-active" : ""}`}
          aria-expanded={moreOpen}
          aria-haspopup="true"
          onClick={() => setMoreOpen((v) => !v)}
        >
          More ▾
        </button>
        {moreOpen && (
          <div className="editor-more-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className={`editor-more-item${state.isUnderline ? " is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            >
              <span className="editor-more-key">U</span> Underline
            </button>
            <div className="editor-more-submenu">
              <button
                type="button"
                className="editor-more-item"
                aria-expanded={highlightOpen}
                onClick={() => setHighlightOpen((v) => !v)}
              >
                Highlight ▸
              </button>
              {highlightOpen && (
                <div className="editor-highlight-palette">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="editor-highlight-swatch"
                      style={{ background: c }}
                      title={c}
                      aria-label={`Highlight ${c}`}
                      onClick={() => {
                        editor.chain().focus().toggleHighlight({ color: c }).run();
                        setHighlightOpen(false);
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className="editor-more-item editor-highlight-clear"
                    onClick={() => {
                      editor.chain().focus().unsetHighlight().run();
                      setHighlightOpen(false);
                    }}
                  >
                    Remove highlight
                  </button>
                </div>
              )}
            </div>
            <div className="editor-more-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className={`editor-more-item${state.isBulletList ? " is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              • Bulleted list
            </button>
            <button
              type="button"
              role="menuitem"
              className={`editor-more-item${state.isOrderedList ? " is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              1. Numbered list
            </button>
            <button
              type="button"
              role="menuitem"
              className={`editor-more-item${state.isTaskList ? " is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleTaskList().run()}
            >
              ☑ Checklist
            </button>
            <div className="editor-more-sep" role="separator" />
            <button type="button" role="menuitem" className="editor-more-item" onClick={setLink}>
              Insert link
            </button>
            <div className="editor-more-sep" role="separator" />
            <div className="editor-more-row editor-more-align">
              <button
                type="button"
                className={`btn btn-ghost btn-tiny${state.align === "left" ? " is-active" : ""}`}
                aria-label="Align left"
                onClick={() => editor.chain().focus().setTextAlign("left").run()}
              >
                Left
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-tiny${state.align === "center" ? " is-active" : ""}`}
                aria-label="Align center"
                onClick={() => editor.chain().focus().setTextAlign("center").run()}
              >
                Center
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-tiny${state.align === "right" ? " is-active" : ""}`}
                aria-label="Align right"
                onClick={() => editor.chain().focus().setTextAlign("right").run()}
              >
                Right
              </button>
            </div>
            <div className="editor-more-row">
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Outdent"
                onClick={liftList}
              >
                ⇤
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Indent"
                onClick={sinkList}
              >
                ⇥
              </button>
            </div>
            <div className="editor-more-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className={`editor-more-item${state.isStrike ? " is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              S̶ Strikethrough
            </button>
            <button
              type="button"
              role="menuitem"
              className={`editor-more-item${state.isSuperscript ? " is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleSuperscript().run()}
            >
              x² Superscript
            </button>
            <button
              type="button"
              role="menuitem"
              className={`editor-more-item${state.isSubscript ? " is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleSubscript().run()}
            >
              x₂ Subscript
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
