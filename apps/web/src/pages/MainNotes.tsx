import type { Editor } from "@tiptap/core";
import { Color } from "@tiptap/extension-color";
import { FontFamily } from "@tiptap/extension-font-family";
import { Highlight } from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWorkspaceOutlet } from "../workspaceOutletContext.js";
import { NoteEditorToolbar } from "../components/NoteEditorToolbar.js";
import { apiGet, apiSend, apiUpload } from "../api.js";
import {
  readLastNotebookId,
  readLastNoteId,
  writeLastNotebookId,
  writeLastNoteId,
} from "../lastSelectionStorage.js";
import {
  createNotesImagePasteDropExtension,
  isLikelyImageFile,
} from "../notesImagePasteDropExtension.js";
import { FontSize } from "../tiptapFontSize.js";

const LIB_COLLAPSED_KEY = "freenotes-library-collapsed";
const NOTES_COLLAPSED_KEY = "freenotes-notes-collapsed";

/** A stack groups notebooks (same idea as Evernote “stacks”). */
type Stack = {
  id: string;
  name: string;
  sortOrder: number;
};

type Notebook = {
  id: string;
  name: string;
  sortOrder: number;
  stackId: string | null;
};

type Note = {
  id: string;
  notebookId: string;
  title: string;
  body: string;
  /** ISO from API; used to show newest notes first. */
  updatedAt?: string;
  createdAt?: string;
};

function noteRecencyMs(n: { updatedAt?: string; createdAt?: string }): number {
  const u = n.updatedAt ? Date.parse(n.updatedAt) : NaN;
  const c = n.createdAt ? Date.parse(n.createdAt) : NaN;
  return Math.max(Number.isFinite(u) ? u : 0, Number.isFinite(c) ? c : 0);
}

function sortNotesNewestFirst<T extends { id: string; updatedAt?: string; createdAt?: string }>(
  list: T[]
): T[] {
  return [...list].sort((a, b) => {
    const ta = noteRecencyMs(a);
    const tb = noteRecencyMs(b);
    if (tb !== ta) return tb - ta;
    return b.id.localeCompare(a.id);
  });
}

type Props = {
  /** Logged-in user; used to scope last notebook/note in localStorage. */
  userId: string;
  googleToken: string | null;
  refreshKey: number;
  onNotebooksChanged: () => void;
};

export function MainNotes({ userId, googleToken, refreshKey, onNotebooksChanged }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isMobile } = useWorkspaceOutlet();
  const [libraryCollapsed, setLibraryCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(LIB_COLLAPSED_KEY) === "1";
  });
  const [notesCollapsed, setNotesCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(NOTES_COLLAPSED_KEY) === "1";
  });
  /** Mobile: 0 = library, 1 = note list, 2 = editor */
  const [mobileStep, setMobileStep] = useState(0);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [activeNb, setActiveNb] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const titleRef = useRef(title);
  titleRef.current = title;
  const [err, setErr] = useState<string | null>(null);
  /** Stack ids that are collapsed (hidden). Default: none = all expanded. */
  const [collapsedStacks, setCollapsedStacks] = useState<Set<string>>(() => new Set());
  /** Which note row has the ⋯ menu open (list). */
  const [noteMenuOpenId, setNoteMenuOpenId] = useState<string | null>(null);
  /** Editor toolbar ⋯ menu. */
  const [editorNoteMenuOpen, setEditorNoteMenuOpen] = useState(false);
  /** Notes panel: ⋯ menu for notebook (e.g. delete). */
  const [notebookPanelMenuOpen, setNotebookPanelMenuOpen] = useState(false);
  /** Move note modal: note being moved. */
  const [moveNote, setMoveNote] = useState<Note | null>(null);
  const [moveTargetNotebookId, setMoveTargetNotebookId] = useState<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const googleTokenRef = useRef(googleToken);
  const activeNoteIdRef = useRef<string | null>(null);
  /** Keep in sync during render — useEffect runs too late for immediate paste after selecting a note. */
  googleTokenRef.current = googleToken;
  activeNoteIdRef.current = activeNote?.id ?? null;

  const uploadFilesForEditorRef = useRef<(files: File[]) => Promise<void>>(
    async () => {}
  );

  const notesImagePasteDropExt = useMemo(
    () =>
      createNotesImagePasteDropExtension(() => ({
        uploadFiles: (files) => uploadFilesForEditorRef.current(files),
      })),
    []
  );

  const activeNotebook = useMemo(
    () => notebooks.find((n) => n.id === activeNb) ?? null,
    [notebooks, activeNb]
  );
  const activeNotebookName = activeNotebook?.name ?? "";
  const activeStackName = useMemo(() => {
    if (!activeNotebook?.stackId) return null;
    return stacks.find((s) => s.id === activeNotebook.stackId)?.name ?? null;
  }, [stacks, activeNotebook]);

  const notesSorted = useMemo(() => sortNotesNewestFirst(notes), [notes]);

  const stacksSorted = useMemo(
    () => [...stacks].sort((a, b) => a.sortOrder - b.sortOrder),
    [stacks]
  );

  const { byStack, ungrouped } = useMemo(() => {
    const by: Record<string, Notebook[]> = {};
    const un: Notebook[] = [];
    for (const n of notebooks) {
      if (!n.stackId) {
        un.push(n);
      } else {
        if (!by[n.stackId]) by[n.stackId] = [];
        by[n.stackId].push(n);
      }
    }
    for (const k of Object.keys(by)) {
      by[k]!.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    un.sort((a, b) => a.sortOrder - b.sortOrder);
    return { byStack: by, ungrouped: un };
  }, [notebooks]);

  const uploadAndInsertImages = useCallback(async (files: File[]) => {
    const noteId = activeNoteIdRef.current;
    const tok = googleTokenRef.current;
    const ed = editorRef.current;
    if (!noteId) {
      setErr("Select a note before pasting or dropping images.");
      return;
    }
    if (!ed) return;
    const images = files.filter(isLikelyImageFile);
    if (!images.length) return;
    for (const file of images) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const j = (await apiUpload(`/api/notes/${noteId}/attachments`, fd, tok)) as {
          attachment: { id: string; url: string };
        };
        const src = j.attachment.url;
        if (!ed.chain().focus().setImage({ src, alt: "" }).run()) {
          ed.chain().focus().insertContent({ type: "image", attrs: { src, alt: "" } }).run();
        }
      } catch (e) {
        setErr(String(e));
      }
    }
  }, []);

  uploadFilesForEditorRef.current = uploadAndInsertImages;

  const editorExtensions = useMemo(
    () => [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight.configure({ multicolor: true }),
      Subscript,
      Superscript,
      TaskItem.configure({ nested: true }),
      TaskList,
      Image.configure({
        inline: true,
        allowBase64: false,
        HTMLAttributes: { class: "note-body-img" },
      }),
      LinkExtension.configure({ openOnClick: true, autolink: true }),
      Placeholder.configure({ placeholder: "Write your note…" }),
      notesImagePasteDropExt,
    ],
    [notesImagePasteDropExt]
  );

  const persist = useCallback(
    async (id: string, t: string, body: string) => {
      try {
        const r = await apiSend<{ note: Note }>(
          `/api/notes/${id}`,
          "PATCH",
          { title: t, body },
          googleToken
        );
        setNotes((prev) => prev.map((n) => (n.id === id ? r.note : n)));
        setActiveNote((n) => (n?.id === id ? r.note : n));
      } catch (e) {
        setErr(String(e));
      }
    },
    [googleToken]
  );

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: "",
      editorProps: {
        attributes: { class: "ProseMirror" },
      },
      onUpdate: ({ editor: ed }) => {
        const id = activeNoteIdRef.current;
        if (!id) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          void persist(id, titleRef.current, ed.getHTML());
        }, 800);
      },
    },
    [editorExtensions, persist]
  );

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const loadLibrary = useCallback(async () => {
    const [st, nb] = await Promise.all([
      apiGet<{ stacks: Stack[] }>("/api/stacks", googleToken),
      apiGet<{ notebooks: Notebook[] }>("/api/notebooks", googleToken),
    ]);
    setStacks(st.stacks);
    setNotebooks(nb.notebooks);
  }, [googleToken]);

  useEffect(() => {
    if (activeNb !== null) return;
    if (notebooks.length === 0) return;
    const fromUrl = searchParams.get("notebook");
    if (fromUrl && notebooks.some((n) => n.id === fromUrl)) {
      setActiveNb(fromUrl);
      return;
    }
    const storedNb = readLastNotebookId(userId);
    if (storedNb && notebooks.some((n) => n.id === storedNb)) {
      setActiveNb(storedNb);
      return;
    }
    setActiveNb(notebooks[0]!.id);
  }, [notebooks, activeNb, searchParams, userId]);

  useEffect(() => {
    window.localStorage.setItem(LIB_COLLAPSED_KEY, libraryCollapsed ? "1" : "0");
  }, [libraryCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(NOTES_COLLAPSED_KEY, notesCollapsed ? "1" : "0");
  }, [notesCollapsed]);

  useEffect(() => {
    if (!isMobile) return;
    if (activeNote) setMobileStep(2);
    else if (activeNb) setMobileStep(1);
    else setMobileStep(0);
  }, [isMobile, activeNote?.id, activeNb]);

  useEffect(() => {
    if (activeNb) writeLastNotebookId(userId, activeNb);
  }, [activeNb, userId]);

  useEffect(() => {
    if (activeNote?.id) writeLastNoteId(userId, activeNote.id);
  }, [activeNote?.id, userId]);

  useEffect(() => {
    void loadLibrary().catch((e) => setErr(String(e)));
  }, [loadLibrary, refreshKey]);

  const loadNotes = useCallback(async () => {
    if (!activeNb) {
      setNotes([]);
      return;
    }
    const r = await apiGet<{ notes: Note[] }>(
      `/api/notes?notebookId=${encodeURIComponent(activeNb)}`,
      googleToken
    );
    setNotes(r.notes);
  }, [activeNb, googleToken]);

  useEffect(() => {
    void loadNotes().catch((e) => setErr(String(e)));
  }, [loadNotes, refreshKey]);

  const closeNoteMenus = useCallback(() => {
    setNoteMenuOpenId(null);
    setEditorNoteMenuOpen(false);
    setNotebookPanelMenuOpen(false);
  }, []);

  useEffect(() => {
    if (noteMenuOpenId === null && !editorNoteMenuOpen && !notebookPanelMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".note-menu-anchor")) return;
      closeNoteMenus();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [noteMenuOpenId, editorNoteMenuOpen, notebookPanelMenuOpen, closeNoteMenus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (moveNote) {
        setMoveNote(null);
        return;
      }
      closeNoteMenus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveNote, closeNoteMenus]);

  useEffect(() => {
    const nb = searchParams.get("notebook");
    const noteId = searchParams.get("note");
    if (!nb && !noteId) return;
    const next = new URLSearchParams(searchParams);
    if (nb) {
      setActiveNb(nb);
      next.delete("notebook");
    }
    if (noteId && notesSorted.length > 0) {
      const found = notesSorted.find((n) => n.id === noteId);
      if (found) {
        setActiveNote(found);
        next.delete("note");
      }
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, notesSorted, setSearchParams]);

  /** After refresh: reopen last note in this notebook (URL `?note=` is handled above). */
  useEffect(() => {
    if (!activeNb || notesSorted.length === 0) return;
    if (searchParams.get("note")) return;

    if (activeNote && notesSorted.some((n) => n.id === activeNote.id)) return;

    const stored = readLastNoteId(userId);
    if (stored && notesSorted.some((n) => n.id === stored)) {
      setActiveNote(notesSorted.find((n) => n.id === stored)!);
      return;
    }
    if (stored) writeLastNoteId(userId, null);
  }, [activeNb, notesSorted, searchParams, activeNote, userId]);

  useEffect(() => {
    if (!activeNote || !editor) return;
    setTitle(activeNote.title);
    editor.commands.setContent(activeNote.body || "<p></p>", false);
  }, [activeNote?.id, editor]);

  const goBackMobile = useCallback(() => {
    setMobileStep((s) => Math.max(0, s - 1));
  }, []);

  const toggleStackCollapsed = useCallback((stackId: string) => {
    setCollapsedStacks((prev) => {
      const next = new Set(prev);
      if (next.has(stackId)) next.delete(stackId);
      else next.add(stackId);
      return next;
    });
  }, []);

  const newStack = useCallback(async () => {
    const name = window.prompt("Stack name (groups notebooks together)");
    if (!name?.trim()) return;
    await apiSend("/api/stacks", "POST", { name: name.trim() }, googleToken);
    onNotebooksChanged();
    void loadLibrary();
  }, [googleToken, loadLibrary, onNotebooksChanged]);

  const removeStack = useCallback(
    async (stackId: string) => {
      if (
        !window.confirm(
          "Remove this stack? Notebooks inside stay in your library as ungrouped."
        )
      ) {
        return;
      }
      await apiSend(`/api/stacks/${stackId}`, "DELETE", undefined, googleToken);
      onNotebooksChanged();
      void loadLibrary();
    },
    [googleToken, loadLibrary, onNotebooksChanged]
  );

  const newNotebookInStack = useCallback(
    async (stackId: string | null) => {
      const name = window.prompt("Notebook name");
      if (!name?.trim()) return;
      await apiSend(
        "/api/notebooks",
        "POST",
        { name: name.trim(), stackId: stackId ?? null },
        googleToken
      );
      onNotebooksChanged();
      void loadLibrary();
    },
    [googleToken, loadLibrary, onNotebooksChanged]
  );

  const deleteNotebook = useCallback(
    async (nb: Notebook) => {
      if (
        !window.confirm(
          `Delete “${nb.name}” and all notes inside it? This cannot be undone.`
        )
      ) {
        return;
      }
      try {
        await apiSend(`/api/notebooks/${nb.id}`, "DELETE", undefined, googleToken);
        if (activeNb === nb.id) {
          setActiveNote(null);
          setActiveNb(null);
          writeLastNotebookId(userId, null);
          writeLastNoteId(userId, null);
        }
        onNotebooksChanged();
        await loadLibrary();
      } catch (e) {
        setErr(String(e));
      }
    },
    [activeNb, googleToken, loadLibrary, onNotebooksChanged, userId]
  );

  const newNote = useCallback(async () => {
    if (!activeNb) return;
    try {
      const r = await apiSend<{ note: Note }>(
        "/api/notes",
        "POST",
        { notebookId: activeNb, title: "Untitled", body: "<p></p>" },
        googleToken
      );
      setNotes((prev) => sortNotesNewestFirst([r.note, ...prev]));
      setActiveNote(r.note);
      if (isMobile) setMobileStep(2);
    } catch (e) {
      setErr(String(e));
    }
  }, [activeNb, googleToken, isMobile]);

  const openNoteInNewWindow = useCallback((note: Note) => {
    closeNoteMenus();
    const url = new URL(window.location.href);
    url.pathname = url.pathname || "/";
    url.search = "";
    url.searchParams.set("notebook", note.notebookId);
    url.searchParams.set("note", note.id);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }, [closeNoteMenus]);

  const openMoveNoteDialog = useCallback(
    (note: Note) => {
      closeNoteMenus();
      const others = notebooks.filter((nb) => nb.id !== note.notebookId);
      if (others.length === 0) {
        setErr("Create another notebook first to move this note.");
        return;
      }
      setMoveNote(note);
      setMoveTargetNotebookId(others[0]!.id);
    },
    [closeNoteMenus, notebooks]
  );

  const confirmMoveNote = useCallback(async () => {
    if (!moveNote || !moveTargetNotebookId) return;
    if (moveTargetNotebookId === moveNote.notebookId) {
      setMoveNote(null);
      return;
    }
    try {
      await apiSend(
        `/api/notes/${moveNote.id}`,
        "PATCH",
        { notebookId: moveTargetNotebookId },
        googleToken
      );
      setMoveNote(null);
      if (activeNote?.id === moveNote.id) setActiveNote(null);
      await loadNotes();
      onNotebooksChanged();
    } catch (e) {
      setErr(String(e));
    }
  }, [
    moveNote,
    moveTargetNotebookId,
    googleToken,
    loadNotes,
    activeNote,
    onNotebooksChanged,
  ]);

  const deleteNoteById = useCallback(
    async (note: Note) => {
      closeNoteMenus();
      if (
        !window.confirm(
          `Delete “${note.title.trim() || "Untitled"}”? This cannot be undone.`
        )
      ) {
        return;
      }
      try {
        await apiSend(`/api/notes/${note.id}`, "DELETE", undefined, googleToken);
        if (activeNote?.id === note.id) setActiveNote(null);
        await loadNotes();
      } catch (e) {
        setErr(String(e));
      }
    },
    [activeNote, closeNoteMenus, googleToken, loadNotes]
  );

  const deleteNote = useCallback(async () => {
    if (!activeNote) return;
    await deleteNoteById(activeNote);
  }, [activeNote, deleteNoteById]);

  const renderNotebookButton = (nb: Notebook) => (
    <li key={nb.id} className="nb-item">
      <button
        type="button"
        className={`link${activeNb === nb.id ? " active" : ""}`}
        aria-current={activeNb === nb.id ? "true" : undefined}
        onClick={() => {
          setActiveNb(nb.id);
          setActiveNote(null);
          if (isMobile) setMobileStep(1);
        }}
      >
        {nb.name}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-tiny danger"
        aria-label={`Delete notebook ${nb.name}`}
        onClick={(e) => {
          e.preventDefault();
          void deleteNotebook(nb);
        }}
      >
        Delete
      </button>
    </li>
  );

  const layoutClass = [
    "notes-layout",
    !isMobile && libraryCollapsed ? "library-collapsed" : "",
    !isMobile && notesCollapsed ? "notes-collapsed" : "",
    isMobile ? `mobile-step-${mobileStep}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const mobileBarTitle =
    mobileStep === 0
      ? "Library"
      : mobileStep === 1
        ? activeNotebookName || "Notes"
        : title.trim() || "Untitled";

  return (
    <div className={layoutClass}>
      {isMobile && (
        <div className="notes-mobile-bar">
          <button
            type="button"
            className="notes-mobile-back"
            onClick={goBackMobile}
            disabled={mobileStep === 0}
            aria-label="Back"
          >
            ←
          </button>
          <span className="notes-mobile-bar-title">{mobileBarTitle}</span>
        </div>
      )}
      <aside className="notebooks-panel" aria-label="Stacks and notebooks">
        {!isMobile && (
          <div className="panel-collapse-row">
            {libraryCollapsed ? (
              <button
                type="button"
                className="panel-collapse-toggle"
                onClick={() => setLibraryCollapsed(false)}
                aria-label="Expand library"
                title="Expand library"
              >
                »
              </button>
            ) : (
              <button
                type="button"
                className="panel-collapse-toggle"
                onClick={() => setLibraryCollapsed(true)}
                aria-label="Collapse library"
                title="Collapse library"
              >
                «
              </button>
            )}
          </div>
        )}
        {!libraryCollapsed || isMobile ? (
          <>
        <div className="toolbar library-toolbar">
          <button type="button" className="btn btn-primary btn-block" onClick={() => void newStack()}>
            + New Stack
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => void newNotebookInStack(null)}>
            New notebook…
          </button>
        </div>

        {stacks.length === 0 && notebooks.length === 0 ? (
          <>
            <p className="library-hint muted">
              Create a stack (optional) and notebooks, then pick one to add notes.
            </p>
            <button type="button" className="library-add-notebook" onClick={() => void newNotebookInStack(null)}>
              + Add notebook
            </button>
          </>
        ) : (
          <>
            {stacksSorted.map((stack) => {
              const nbs = byStack[stack.id] ?? [];
              const collapsed = collapsedStacks.has(stack.id);
              return (
                <div key={stack.id} className="stack-block">
                  <div className="stack-header">
                    <button
                      type="button"
                      className="stack-chevron"
                      aria-expanded={!collapsed}
                      aria-label={collapsed ? "Expand stack" : "Collapse stack"}
                      onClick={() => toggleStackCollapsed(stack.id)}
                    >
                      {collapsed ? "▸" : "▾"}
                    </button>
                    <span className="stack-title" title={stack.name}>
                      {stack.name}
                    </span>
                    <div className="stack-actions">
                      <button type="button" className="btn btn-ghost btn-tiny" onClick={() => void newNotebookInStack(stack.id)}>
                        + Notebook
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-tiny danger"
                        onClick={() => void removeStack(stack.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {!collapsed && (
                    <ul className="nb-list stack-nb-list" role="list">
                      {nbs.length === 0 ? (
                        <li className="muted empty-inline">No notebooks in this stack.</li>
                      ) : (
                        nbs.map((nb) => renderNotebookButton(nb))
                      )}
                    </ul>
                  )}
                </div>
              );
            })}

            <div className="stack-block stack-block-ungrouped">
              <div className="stack-header stack-header-static">
                <span className="stack-title">Ungrouped notebooks</span>
                <button type="button" className="btn btn-ghost btn-tiny" onClick={() => void newNotebookInStack(null)}>
                  + Notebook
                </button>
              </div>
              <ul className="nb-list stack-nb-list" role="list">
                {ungrouped.length === 0 ? (
                  <li className="muted empty-inline">None — add one above.</li>
                ) : (
                  ungrouped.map((nb) => renderNotebookButton(nb))
                )}
              </ul>
            </div>
            <button
              type="button"
              className="library-add-notebook"
              onClick={() => void newNotebookInStack(null)}
            >
              + Add notebook
            </button>
          </>
        )}
          </>
        ) : null}
      </aside>

      <section className="notes-panel" aria-label="Notes in notebook">
        {!isMobile && (
          <div className="panel-collapse-row">
            {notesCollapsed ? (
              <button
                type="button"
                className="panel-collapse-toggle"
                onClick={() => setNotesCollapsed(false)}
                aria-label="Expand note list"
                title="Expand note list"
              >
                »
              </button>
            ) : (
              <button
                type="button"
                className="panel-collapse-toggle"
                onClick={() => setNotesCollapsed(true)}
                aria-label="Collapse note list"
                title="Collapse note list"
              >
                «
              </button>
            )}
          </div>
        )}
        {!notesCollapsed || isMobile ? (
        <>
        {!activeNotebook ? (
          <div className="notes-panel-body">
            <div className="notes-panel-empty">
              <p className="empty-hint" style={{ margin: 0 }}>Select a notebook to view its notes</p>
            </div>
          </div>
        ) : (
          <>
            <div className="stack-section-title">Notes</div>
            <div className="notes-panel-header">
              <div className="notes-panel-header-main">
                <strong title={activeNotebookName}>{activeNotebookName}</strong>
                {activeStackName && <div className="notes-panel-meta">In stack: {activeStackName}</div>}
                <div className="notes-panel-meta">
                  {notesSorted.length === 1 ? "1 note" : `${notesSorted.length} notes`}
                </div>
              </div>
              <div className="note-menu-anchor notes-panel-header-menu">
                <button
                  type="button"
                  className="note-menu-trigger"
                  aria-label="Notebook options"
                  aria-haspopup="menu"
                  aria-expanded={notebookPanelMenuOpen}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditorNoteMenuOpen(false);
                    setNoteMenuOpenId(null);
                    setNotebookPanelMenuOpen((v) => !v);
                  }}
                >
                  ⋯
                </button>
                {notebookPanelMenuOpen && (
                  <ul className="note-actions-menu" role="menu">
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="note-actions-menu-item danger"
                        onClick={() => {
                          setNotebookPanelMenuOpen(false);
                          void deleteNotebook(activeNotebook);
                        }}
                      >
                        Delete notebook…
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            </div>
            <div className="toolbar notes-panel-toolbar">
              <button type="button" className="btn btn-primary" onClick={() => void newNote()}>
                +Note
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => navigate("/search")}
                aria-label="Search notes"
              >
                Search
              </button>
            </div>
            {notesSorted.length === 0 ? (
              <p className="empty-hint">No notes in this notebook yet. Add one to start writing.</p>
            ) : (
              <ul className="notes-list" role="list">
                {notesSorted.map((n) => (
                  <li key={n.id} className="notes-list-item">
                    <button
                      type="button"
                      className={`note-item${activeNote?.id === n.id ? " active" : ""}`}
                      aria-current={activeNote?.id === n.id ? "true" : undefined}
                      onClick={() => {
                        setActiveNote(n);
                        if (isMobile) setMobileStep(2);
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{n.title || "Untitled"}</div>
                    </button>
                    <div className="note-menu-anchor">
                      <button
                        type="button"
                        className="note-menu-trigger"
                        aria-label={`Options for ${n.title || "Untitled"}`}
                        aria-haspopup="menu"
                        aria-expanded={noteMenuOpenId === n.id}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setNotebookPanelMenuOpen(false);
                          setEditorNoteMenuOpen(false);
                          setNoteMenuOpenId((prev) => (prev === n.id ? null : n.id));
                        }}
                      >
                        ⋯
                      </button>
                      {noteMenuOpenId === n.id && (
                        <ul className="note-actions-menu" role="menu">
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              className="note-actions-menu-item"
                              onClick={() => openNoteInNewWindow(n)}
                            >
                              Open in new window
                            </button>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              className="note-actions-menu-item"
                              onClick={() => openMoveNoteDialog(n)}
                            >
                              Move to…
                            </button>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              className="note-actions-menu-item danger"
                              onClick={() => void deleteNoteById(n)}
                            >
                              Delete
                            </button>
                          </li>
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        </>
        ) : null}
      </section>

      <main className="editor-panel" aria-label="Note editor">
        {err && (
          <div style={{ color: "var(--danger)" }} role="alert">
            {err}
          </div>
        )}
        {activeNote && activeNotebook ? (
          <>
            <div className="editor-breadcrumb" aria-live="polite">
              {activeStackName && (
                <>
                  <span className="nb-crumb">{activeStackName}</span>
                  <span className="sep" aria-hidden="true">
                    /
                  </span>
                </>
              )}
              <span className="nb-crumb">{activeNotebookName}</span>
              <span className="sep" aria-hidden="true">
                /
              </span>
              <span>{title.trim() || "Untitled"}</span>
            </div>
            <div className="toolbar editor-toolbar">
              <NoteEditorToolbar editor={editor} />
              <div className="note-menu-anchor editor-note-menu">
                <button
                  type="button"
                  className="note-menu-trigger"
                  aria-label="Note options"
                  aria-haspopup="menu"
                  aria-expanded={editorNoteMenuOpen}
                  onClick={(e) => {
                    e.preventDefault();
                    setNotebookPanelMenuOpen(false);
                    setNoteMenuOpenId(null);
                    setEditorNoteMenuOpen((v) => !v);
                  }}
                >
                  ⋯
                </button>
                {editorNoteMenuOpen && activeNote && (
                  <ul className="note-actions-menu" role="menu">
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="note-actions-menu-item"
                        onClick={() => openNoteInNewWindow(activeNote)}
                      >
                        Open in new window
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="note-actions-menu-item"
                        onClick={() => openMoveNoteDialog(activeNote)}
                      >
                        Move to…
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="note-actions-menu-item danger"
                        onClick={() => void deleteNote()}
                      >
                        Delete
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            </div>
            <input
              className="title-input"
              value={title}
              aria-label="Note title"
              placeholder="Title"
              onChange={(e) => {
                const v = e.target.value;
                setTitle(v);
                if (saveTimer.current) clearTimeout(saveTimer.current);
                saveTimer.current = setTimeout(() => {
                  if (editor) void persist(activeNote.id, v, editor.getHTML());
                }, 500);
              }}
            />
            <EditorContent editor={editor} />
          </>
        ) : (
          <div
            className="empty-hint"
            style={{ alignSelf: "center", margin: "auto", maxWidth: 400, padding: "2rem 1rem" }}
          >
            {notebooks.length === 0 ? (
              <>
                <span className="empty-hint-title">Welcome</span>
                <p className="empty-hint-sub">
                  Your structure is: <strong>Stack → Notebook → Note</strong>. Stacks are optional; you can keep
                  notebooks ungrouped.
                </p>
              </>
            ) : !activeNotebook ? (
              <>
                <span className="empty-hint-title">No Note Selected</span>
                <p className="empty-hint-sub">Select a notebook and open a note to start writing.</p>
              </>
            ) : (
              <>
                <span className="empty-hint-title">No Note Selected</span>
                <p className="empty-hint-sub">
                  Open a note from <strong>{activeNotebookName}</strong>, or use <strong>+Note</strong>.
                </p>
              </>
            )}
          </div>
        )}
      </main>

      {moveNote && (
        <div className="modal-backdrop" role="presentation" onClick={() => setMoveNote(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-note-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="move-note-title" style={{ marginTop: 0 }}>
              Move note
            </h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Move “{moveNote.title.trim() || "Untitled"}” to:
            </p>
            <select
              className="input"
              value={moveTargetNotebookId}
              onChange={(e) => setMoveTargetNotebookId(e.target.value)}
              aria-label="Target notebook"
              style={{ marginBottom: "1rem" }}
            >
              {notebooks
                .filter((nb) => nb.id !== moveNote.notebookId)
                .map((nb) => (
                  <option key={nb.id} value={nb.id}>
                    {nb.name}
                  </option>
                ))}
            </select>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setMoveNote(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void confirmMoveNote()}>
                Move
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
