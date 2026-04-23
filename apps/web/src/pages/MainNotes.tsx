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
import { TextDiffPanel } from "../components/TextDiffPanel.js";
import { normalizeNoteHtmlForPreview } from "../normalizeNoteHtmlPreview.js";
import { normalizeTaskListHtmlForEditor } from "../normalizeTaskListHtmlForEditor.js";
import { apiGet, apiSend, apiUpload } from "../api.js";
import {
  clearNoteBodyBackup,
  isTrivialEmptyHtml,
  readNoteBodyBackup,
  writeNoteBodyBackup,
  type NoteBodyBackup,
} from "../noteBodyBackup.js";
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
import type { User } from "../App.js";

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
  createdAt?: string;
  updatedAt?: string;
  /** ISO; server sets from latest note in notebook (max created/updated). */
  lastNoteActivityAt?: string | null;
};

/** Ungrouped notebooks may have stackId null, missing, or "" — align with API / Firestore. */
function normalizedNotebookStackId(nb: { stackId?: string | null }): string | null {
  const s = nb.stackId;
  if (s == null || s === "") return null;
  return s;
}

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

/** Library order: latest note activity in notebook, then notebook timestamps, then manual order. */
function notebookRecencyMs(nb: Notebook): number {
  if (nb.lastNoteActivityAt) {
    const n = Date.parse(nb.lastNoteActivityAt);
    if (Number.isFinite(n)) return n;
  }
  const u = nb.updatedAt ? Date.parse(nb.updatedAt) : NaN;
  const c = nb.createdAt ? Date.parse(nb.createdAt) : NaN;
  return Math.max(Number.isFinite(u) ? u : 0, Number.isFinite(c) ? c : 0);
}

function sortNotebooksForLibrary(a: Notebook, b: Notebook): number {
  const ta = notebookRecencyMs(a);
  const tb = notebookRecencyMs(b);
  if (tb !== ta) return tb - ta;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

/** Keep sidebar order in sync after saves (library is not refetched on every autosave). */
function notebookWithMergedNoteActivity(nb: Notebook, note: Note): Notebook {
  const noteMs = noteRecencyMs(note);
  const prevMs = notebookRecencyMs(nb);
  const maxMs = Math.max(prevMs, noteMs);
  return { ...nb, lastNoteActivityAt: new Date(maxMs).toISOString() };
}

type Props = {
  user: User;
  googleToken: string | null;
  refreshKey: number;
  onNotebooksChanged: () => void;
};

type SimilarCandidate = {
  id: string;
  score: number;
  reason: string;
  title: string;
};

type EmptyNoteSuggestion = {
  id: string;
  title: string;
  /** Plain-text body snippet so you can confirm the note is truly empty before deleting */
  bodyPreview: string;
};

const MERGE_AUTO_CHECK_MIN_SCORE = 0.32;

type OrganizeSuggestion = {
  noteId: string;
  suggestedNotebookId: string;
  reason: string;
  confidence: number;
};

export function MainNotes({ user, googleToken, refreshKey, onNotebooksChanged }: Props) {
  const userId = user.id;
  const aiTierActive = user.aiTierActive;
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
  /** Mobile: 0 = stacks + notebooks, 1 = note list, 2 = editor */
  const [mobileStep, setMobileStep] = useState(0);
  /** Which stack’s notebooks are listed (null = Ungrouped). */
  const [libraryStackId, setLibraryStackId] = useState<string | null>(null);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [activeNb, setActiveNb] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const titleRef = useRef(title);
  titleRef.current = title;
  /** Avoid resetting the library stack column on every `notebooks` refetch while the same notebook stays active. */
  const libraryStackSyncedForRef = useRef<{
    activeNb: string;
    stackId: string | null;
  } | null>(null);
  /** True after user picks a stack (or Ungrouped) in the sidebar — avoids re-selecting last notebook from another stack. */
  const libraryFilterUserChosenRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [localBodyBackupHint, setLocalBodyBackupHint] = useState<NoteBodyBackup | null>(null);
  /** Which note row has the ⋯ menu open (list). */
  const [noteMenuOpenId, setNoteMenuOpenId] = useState<string | null>(null);
  /** Editor toolbar ⋯ menu. */
  const [editorNoteMenuOpen, setEditorNoteMenuOpen] = useState(false);
  /** Notes panel: ⋯ menu for notebook (e.g. delete). */
  const [notebookPanelMenuOpen, setNotebookPanelMenuOpen] = useState(false);
  /** Library sidebar: ⋯ menu for a notebook (stack / delete). */
  const [notebookListMenuOpenId, setNotebookListMenuOpenId] = useState<string | null>(null);
  /** Move note modal: note being moved. */
  const [moveNote, setMoveNote] = useState<Note | null>(null);
  const [moveTargetNotebookId, setMoveTargetNotebookId] = useState<string>("");
  const [aiToolbarOpen, setAiToolbarOpen] = useState(false);
  const [aiCleanupReview, setAiCleanupReview] = useState<{
    beforeHtml: string;
    afterHtml: string;
    beforeText: string;
    afterText: string;
  } | null>(null);
  const [aiSimilar, setAiSimilar] = useState<{
    noteId: string;
    sourceTitle: string;
    scope: "notebook" | "all";
    candidates: SimilarCandidate[];
    emptyNotes: EmptyNoteSuggestion[];
  } | null>(null);
  const [similarSelected, setSimilarSelected] = useState<Record<string, boolean>>({});
  /** Empty-note rows: checked = include in bulk delete (default off until user reviews preview). */
  const [emptyNotesDeleteSelected, setEmptyNotesDeleteSelected] = useState<
    Record<string, boolean>
  >({});
  const [mergePrimaryId, setMergePrimaryId] = useState<string>("");
  const [aiMerge, setAiMerge] = useState<{
    primaryId: string;
    otherIds: string[];
    mergedHtml: string;
    warnings: string[];
    beforeHtml: string;
    beforeText: string;
    afterText: string;
  } | null>(null);
  const [aiOrganize, setAiOrganize] = useState<{
    suggestions: OrganizeSuggestion[];
    accepted: Record<string, boolean>;
  } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last body successfully stored on the server (load or last PATCH) — for wipe detection. */
  const lastServerBodyRef = useRef<string>("");
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
    const sid = activeNotebook ? normalizedNotebookStackId(activeNotebook) : null;
    if (!sid) return null;
    return stacks.find((s) => s.id === sid)?.name ?? null;
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
      const sid = normalizedNotebookStackId(n);
      if (sid === null) {
        un.push(n);
      } else {
        if (!by[sid]) by[sid] = [];
        by[sid].push(n);
      }
    }
    for (const k of Object.keys(by)) {
      by[k]!.sort(sortNotebooksForLibrary);
    }
    un.sort(sortNotebooksForLibrary);
    return { byStack: by, ungrouped: un };
  }, [notebooks]);

  const notebooksForLibraryColumn = useMemo(
    () =>
      libraryStackId === null ? ungrouped : (byStack[libraryStackId] ?? []),
    [libraryStackId, ungrouped, byStack]
  );

  const selectedStackLabel = useMemo(() => {
    if (libraryStackId === null) return "Ungrouped";
    return stacks.find((s) => s.id === libraryStackId)?.name ?? "Stack";
  }, [libraryStackId, stacks]);

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

  const bumpNotebookFromSavedNote = useCallback((note: Note) => {
    setNotebooks((prev) =>
      prev.map((nb) =>
        nb.id === note.notebookId ? notebookWithMergedNoteActivity(nb, note) : nb
      )
    );
  }, []);

  const persist = useCallback(
    async (id: string, t: string, body: string) => {
      const previous = lastServerBodyRef.current;
      if (isTrivialEmptyHtml(body) && !isTrivialEmptyHtml(previous)) {
        const ok = window.confirm(
          "This save will clear all text in the note. If this was an accident, choose Cancel — your previous content stays until you save again. Continue and clear the note on the server?"
        );
        if (!ok) {
          const ed = editorRef.current;
          if (ed) {
            ed.commands.setContent(normalizeTaskListHtmlForEditor(previous || "<p></p>"), false);
          }
          return;
        }
      }
      try {
        const r = await apiSend<{ note: Note }>(
          `/api/notes/${id}`,
          "PATCH",
          { title: t, body },
          googleToken
        );
        lastServerBodyRef.current = r.note.body;
        if (isTrivialEmptyHtml(r.note.body)) {
          clearNoteBodyBackup(userId, id);
        } else {
          writeNoteBodyBackup(userId, id, r.note.title, r.note.body);
        }
        if (r.note.id === activeNoteIdRef.current) {
          setLocalBodyBackupHint(null);
        }
        setNotes((prev) =>
          sortNotesNewestFirst(
            prev.map((n) => (n.id === id ? r.note : n))
          )
        );
        setActiveNote((n) => (n?.id === id ? r.note : n));
        bumpNotebookFromSavedNote(r.note);
      } catch (e) {
        setErr(String(e));
      }
    },
    [googleToken, userId, bumpNotebookFromSavedNote]
  );

  const restoreFromLocalBodyBackup = useCallback(async () => {
    if (!activeNote || !localBodyBackupHint) return;
    const body = localBodyBackupHint.body;
    const t = titleRef.current.trim() || activeNote.title;
    try {
      const r = await apiSend<{ note: Note }>(
        `/api/notes/${activeNote.id}`,
        "PATCH",
        { title: t, body },
        googleToken
      );
      lastServerBodyRef.current = r.note.body;
      writeNoteBodyBackup(userId, r.note.id, r.note.title, r.note.body);
      setLocalBodyBackupHint(null);
      setNotes((prev) =>
        sortNotesNewestFirst(
          prev.map((n) => (n.id === r.note.id ? r.note : n))
        )
      );
      setActiveNote((n) => (n?.id === r.note.id ? r.note : n));
      bumpNotebookFromSavedNote(r.note);
      const ed = editorRef.current;
      if (ed) {
        ed.commands.setContent(
          normalizeTaskListHtmlForEditor(r.note.body || "<p></p>"),
          false
        );
      }
    } catch (e) {
      setErr(String(e));
    }
  }, [activeNote, localBodyBackupHint, googleToken, userId, bumpNotebookFromSavedNote]);

  const dismissLocalBodyBackup = useCallback(() => {
    if (!activeNote) return;
    clearNoteBodyBackup(userId, activeNote.id);
    setLocalBodyBackupHint(null);
  }, [activeNote, userId]);

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
    if (!libraryFilterUserChosenRef.current) {
      const storedNb = readLastNotebookId(userId);
      if (storedNb && notebooks.some((n) => n.id === storedNb)) {
        setActiveNb(storedNb);
        return;
      }
      setActiveNb(notebooks[0]!.id);
      return;
    }
    const visible = notebooksForLibraryColumn;
    const storedNb = readLastNotebookId(userId);
    if (storedNb && visible.some((n) => n.id === storedNb)) {
      setActiveNb(storedNb);
      return;
    }
    if (visible[0]) {
      setActiveNb(visible[0].id);
    }
  }, [notebooks, activeNb, searchParams, userId, notebooksForLibraryColumn]);

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

  useEffect(() => {
    if (!activeNb) {
      libraryStackSyncedForRef.current = null;
      return;
    }
    const nb = notebooks.find((n) => n.id === activeNb);
    if (!nb) return;
    const sid = normalizedNotebookStackId(nb);
    const prev = libraryStackSyncedForRef.current;
    if (!prev || prev.activeNb !== activeNb) {
      libraryStackSyncedForRef.current = { activeNb, stackId: sid };
      setLibraryStackId(sid);
      return;
    }
    if (prev.stackId !== sid) {
      libraryStackSyncedForRef.current = { activeNb, stackId: sid };
      setLibraryStackId(sid);
    }
  }, [activeNb, notebooks]);

  useEffect(() => {
    if (!activeNb) return;
    const nb = notebooks.find((n) => n.id === activeNb);
    if (!nb) return;
    const sid = normalizedNotebookStackId(nb);
    const inView =
      libraryStackId === null ? sid === null : sid === libraryStackId;
    if (!inView) {
      setActiveNb(null);
      setActiveNote(null);
    }
  }, [libraryStackId, activeNb, notebooks]);

  const loadNotes = useCallback(async () => {
    if (!activeNb) {
      setNotes([]);
      return;
    }
    const r = await apiGet<{ notes: Note[] }>(
      `/api/notes?notebookId=${encodeURIComponent(activeNb)}`,
      googleToken
    );
    setNotes(sortNotesNewestFirst(r.notes));
  }, [activeNb, googleToken]);

  useEffect(() => {
    void loadNotes().catch((e) => setErr(String(e)));
  }, [loadNotes, refreshKey]);

  const closeNoteMenus = useCallback(() => {
    setNoteMenuOpenId(null);
    setEditorNoteMenuOpen(false);
    setNotebookPanelMenuOpen(false);
    setNotebookListMenuOpenId(null);
    setAiToolbarOpen(false);
  }, []);

  useEffect(() => {
    if (
      noteMenuOpenId === null &&
      !editorNoteMenuOpen &&
      !notebookPanelMenuOpen &&
      !aiToolbarOpen &&
      notebookListMenuOpenId === null
    ) {
      return;
    }
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".note-menu-anchor")) return;
      closeNoteMenus();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [
    noteMenuOpenId,
    editorNoteMenuOpen,
    notebookPanelMenuOpen,
    notebookListMenuOpenId,
    aiToolbarOpen,
    closeNoteMenus,
  ]);

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
    const rawBody = activeNote.body || "<p></p>";
    lastServerBodyRef.current = activeNote.body || "";
    editor.commands.setContent(
      normalizeTaskListHtmlForEditor(rawBody),
      false
    );
  }, [activeNote?.id, editor]);

  useEffect(() => {
    if (!activeNote?.id) {
      setLocalBodyBackupHint(null);
      return;
    }
    const bhtml = activeNote.body || "";
    if (!isTrivialEmptyHtml(bhtml)) {
      writeNoteBodyBackup(userId, activeNote.id, activeNote.title, bhtml);
      setLocalBodyBackupHint(null);
    } else {
      const b = readNoteBodyBackup(userId, activeNote.id);
      if (b && !isTrivialEmptyHtml(b.body)) {
        setLocalBodyBackupHint(b);
      } else {
        setLocalBodyBackupHint(null);
      }
    }
  }, [userId, activeNote?.id, activeNote?.body, activeNote?.title]);

  const goBackMobile = useCallback(() => {
    setMobileStep((s) => Math.max(0, s - 1));
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
      setLibraryStackId((prev) => (prev === stackId ? null : prev));
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
        setNotebookListMenuOpenId(null);
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

  const moveNotebookToStack = useCallback(
    async (nb: Notebook, stackId: string | null) => {
      const target = stackId ?? null;
      if (normalizedNotebookStackId(nb) === target) {
        setNotebookListMenuOpenId(null);
        return;
      }
      setNotebookListMenuOpenId(null);
      try {
        await apiSend(
          `/api/notebooks/${nb.id}`,
          "PATCH",
          { stackId },
          googleToken
        );
        onNotebooksChanged();
        await loadLibrary();
      } catch (e) {
        setErr(String(e));
      }
    },
    [googleToken, loadLibrary, onNotebooksChanged]
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
      bumpNotebookFromSavedNote(r.note);
      if (isMobile) setMobileStep(2);
    } catch (e) {
      setErr(String(e));
    }
  }, [activeNb, googleToken, isMobile, bumpNotebookFromSavedNote]);

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
        onNotebooksChanged();
      } catch (e) {
        setErr(String(e));
      }
    },
    [activeNote, closeNoteMenus, googleToken, loadNotes, onNotebooksChanged]
  );

  const deleteNote = useCallback(async () => {
    if (!activeNote) return;
    await deleteNoteById(activeNote);
  }, [activeNote, deleteNoteById]);

  const runCleanupPreview = useCallback(async () => {
    if (!editor || !aiTierActive || !activeNote) return;
    try {
      const html = editor.getHTML();
      const r = await apiSend<{
        html: string;
        beforeText: string;
        afterText: string;
      }>("/api/ai/cleanup-note", "POST", { html }, googleToken);
      setAiToolbarOpen(false);
      setAiCleanupReview({
        beforeHtml: html,
        afterHtml: r.html,
        beforeText: r.beforeText,
        afterText: r.afterText,
      });
    } catch (e) {
      setErr(String(e));
    }
  }, [editor, aiTierActive, activeNote, googleToken]);

  const openSimilarForNote = useCallback(
    async (noteId: string, scope: "notebook" | "all", sourceTitle?: string) => {
      if (!aiTierActive) return;
      closeNoteMenus();
      const resolvedTitle =
        (sourceTitle ?? notesSorted.find((n) => n.id === noteId)?.title ?? "").trim() ||
        "Untitled";
      try {
        const r = await apiSend<{
          candidates: SimilarCandidate[];
          emptyNotes: EmptyNoteSuggestion[];
        }>(
          "/api/ai/similar-notes",
          "POST",
          { noteId, scope, limit: 20 },
          googleToken
        );
        const sel: Record<string, boolean> = {};
        for (const c of r.candidates) {
          sel[c.id] = c.score >= MERGE_AUTO_CHECK_MIN_SCORE;
        }
        setSimilarSelected(sel);
        setMergePrimaryId(noteId);
        const emptyList = r.emptyNotes ?? [];
        const emptySel: Record<string, boolean> = {};
        for (const en of emptyList) emptySel[en.id] = false;
        setEmptyNotesDeleteSelected(emptySel);
        setAiSimilar({
          noteId,
          sourceTitle: resolvedTitle,
          scope,
          candidates: r.candidates,
          emptyNotes: emptyList,
        });
      } catch (e) {
        setErr(String(e));
      }
    },
    [aiTierActive, closeNoteMenus, googleToken, notesSorted]
  );

  const deleteEmptySuggestedNotes = useCallback(async () => {
    if (!aiSimilar?.emptyNotes.length) return;
    const list = aiSimilar.emptyNotes.filter(
      (en) => emptyNotesDeleteSelected[en.id]
    );
    if (list.length === 0) {
      setErr(
        "Select one or more notes to delete after reviewing the body preview below each title."
      );
      return;
    }
    if (
      !window.confirm(
        `Delete ${list.length} selected note(s)? This cannot be undone.`
      )
    ) {
      return;
    }
    try {
      for (const en of list) {
        await apiSend(`/api/notes/${en.id}`, "DELETE", undefined, googleToken);
      }
      if (list.some((en) => en.id === activeNote?.id)) setActiveNote(null);
      const deleted = new Set(list.map((en) => en.id));
      setAiSimilar((prev) =>
        prev
          ? {
              ...prev,
              emptyNotes: prev.emptyNotes.filter((en) => !deleted.has(en.id)),
            }
          : null
      );
      setEmptyNotesDeleteSelected((prev) => {
        const next = { ...prev };
        for (const id of deleted) delete next[id];
        return next;
      });
      await loadNotes();
      onNotebooksChanged();
    } catch (e) {
      setErr(String(e));
    }
  }, [
    aiSimilar,
    emptyNotesDeleteSelected,
    googleToken,
    loadNotes,
    onNotebooksChanged,
    activeNote?.id,
  ]);

  const runMergePreviewFromSimilar = useCallback(async () => {
    if (!aiSimilar) return;
    const others = Object.entries(similarSelected)
      .filter(([, v]) => v)
      .map(([id]) => id);
    const primary = mergePrimaryId;
    const otherNoteIds = others.filter((id) => id !== primary);
    if (otherNoteIds.length === 0) {
      setErr("Select at least one other note (not the primary) to merge.");
      return;
    }
    try {
      const r = await apiSend<{
        mergedHtml: string;
        warnings: string[];
        beforeHtml: string;
        beforeText: string;
        afterText: string;
      }>(
        "/api/ai/merge-preview",
        "POST",
        { primaryNoteId: primary, otherNoteIds },
        googleToken
      );
      setAiMerge({
        primaryId: primary,
        otherIds: otherNoteIds,
        mergedHtml: r.mergedHtml,
        warnings: r.warnings,
        beforeHtml: r.beforeHtml,
        beforeText: r.beforeText,
        afterText: r.afterText,
      });
    } catch (e) {
      setErr(String(e));
    }
  }, [aiSimilar, similarSelected, mergePrimaryId, googleToken]);

  const commitMerge = useCallback(async () => {
    if (!aiMerge) return;
    try {
      const r = await apiSend<{ note: Note }>(
        "/api/ai/merge-commit",
        "POST",
        {
          primaryNoteId: aiMerge.primaryId,
          otherNoteIds: aiMerge.otherIds,
          mergedHtml: aiMerge.mergedHtml,
        },
        googleToken
      );
      setAiMerge(null);
      setAiSimilar(null);
      setSimilarSelected({});
      setEmptyNotesDeleteSelected({});
      await loadNotes();
      onNotebooksChanged();
      setActiveNote(r.note);
      if (editor) {
        editor.commands.setContent(
          normalizeTaskListHtmlForEditor(r.note.body || "<p></p>"),
          false
        );
      }
      setTitle(r.note.title);
    } catch (e) {
      setErr(String(e));
    }
  }, [aiMerge, googleToken, loadNotes, onNotebooksChanged, editor]);

  const runOrganizeSuggestions = useCallback(async () => {
    if (!activeNb || !aiTierActive) return;
    const noteIds = notesSorted.map((n) => n.id);
    if (noteIds.length === 0) return;
    setNotebookPanelMenuOpen(false);
    try {
      const r = await apiSend<{ suggestions: OrganizeSuggestion[] }>(
        "/api/ai/suggest-notebooks",
        "POST",
        { noteIds },
        googleToken
      );
      const acc: Record<string, boolean> = {};
      for (const s of r.suggestions) acc[s.noteId] = true;
      setAiOrganize({ suggestions: r.suggestions, accepted: acc });
    } catch (e) {
      setErr(String(e));
    }
  }, [activeNb, aiTierActive, notesSorted, googleToken]);

  const applyOrganize = useCallback(async () => {
    if (!aiOrganize) return;
    const applies = aiOrganize.suggestions
      .filter((s) => aiOrganize.accepted[s.noteId])
      .map((s) => ({ noteId: s.noteId, notebookId: s.suggestedNotebookId }));
    if (applies.length === 0) {
      setAiOrganize(null);
      return;
    }
    try {
      await apiSend("/api/ai/apply-suggestions", "POST", { applies }, googleToken);
      setAiOrganize(null);
      await loadNotes();
      onNotebooksChanged();
      await loadLibrary();
    } catch (e) {
      setErr(String(e));
    }
  }, [aiOrganize, googleToken, loadNotes, loadLibrary, onNotebooksChanged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (aiMerge) {
        setAiMerge(null);
        setAiToolbarOpen(false);
        return;
      }
      if (aiCleanupReview) {
        setAiCleanupReview(null);
        setAiToolbarOpen(false);
        return;
      }
      if (aiSimilar) {
        setAiSimilar(null);
        setSimilarSelected({});
        setEmptyNotesDeleteSelected({});
        setAiMerge(null);
        setAiToolbarOpen(false);
        return;
      }
      if (aiOrganize) {
        setAiOrganize(null);
        setAiToolbarOpen(false);
        return;
      }
      if (moveNote) {
        setMoveNote(null);
        return;
      }
      closeNoteMenus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    moveNote,
    closeNoteMenus,
    aiCleanupReview,
    aiSimilar,
    aiMerge,
    aiOrganize,
  ]);

  const renderNotebookButton = (nb: Notebook) => (
    <li key={nb.id} className="nb-item">
      <button
        type="button"
        className={`link${activeNb === nb.id ? " active" : ""}`}
        aria-current={activeNb === nb.id ? "true" : undefined}
        onClick={() => {
          setLibraryStackId(normalizedNotebookStackId(nb));
          setActiveNb(nb.id);
          setActiveNote(null);
          if (isMobile) setMobileStep(1);
        }}
      >
        {nb.name}
      </button>
      <div className="note-menu-anchor nb-item-menu">
        <button
          type="button"
          className="note-menu-trigger"
          aria-label={`Notebook options: ${nb.name}`}
          aria-haspopup="menu"
          aria-expanded={notebookListMenuOpenId === nb.id}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setNotebookPanelMenuOpen(false);
            setEditorNoteMenuOpen(false);
            setNoteMenuOpenId(null);
            setNotebookListMenuOpenId((prev) => (prev === nb.id ? null : nb.id));
          }}
        >
          ⋯
        </button>
        {notebookListMenuOpenId === nb.id && (
          <ul className="note-actions-menu" role="menu">
            {stacksSorted.length === 0 ? (
              <li role="none">
                <span
                  className="note-actions-menu-item"
                  style={{ cursor: "default", opacity: 0.8 }}
                >
                  No stacks yet — use + New Stack above
                </span>
              </li>
            ) : (
              stacksSorted.map((st) =>
                st.id !== normalizedNotebookStackId(nb) ? (
                  <li key={st.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="note-actions-menu-item"
                      onClick={() => void moveNotebookToStack(nb, st.id)}
                    >
                      {normalizedNotebookStackId(nb)
                        ? `Move to ${st.name}`
                        : `Add to ${st.name}`}
                    </button>
                  </li>
                ) : null
              )
            )}
            {normalizedNotebookStackId(nb) != null ? (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="note-actions-menu-item"
                  onClick={() => void moveNotebookToStack(nb, null)}
                >
                  Move to Ungrouped
                </button>
              </li>
            ) : null}
            <li role="none" className="note-actions-menu-divider-before">
              <button
                type="button"
                role="menuitem"
                className="note-actions-menu-item danger"
                onClick={() => void deleteNotebook(nb)}
              >
                Delete notebook…
              </button>
            </li>
          </ul>
        )}
      </div>
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
      ? "Stacks & notebooks"
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
      <div className="library-split">
        <aside className="stacks-panel" aria-label="Stacks">
          {!isMobile && (
            <div className="panel-collapse-row">
              {libraryCollapsed ? (
                <button
                  type="button"
                  className="panel-collapse-toggle"
                  onClick={() => setLibraryCollapsed(false)}
                  aria-label="Expand stacks and notebooks"
                  title="Expand stacks and notebooks"
                >
                  »
                </button>
              ) : (
                <button
                  type="button"
                  className="panel-collapse-toggle"
                  onClick={() => setLibraryCollapsed(true)}
                  aria-label="Collapse stacks and notebooks"
                  title="Collapse stacks and notebooks"
                >
                  «
                </button>
              )}
            </div>
          )}
          {!libraryCollapsed || isMobile ? (
            <>
              <div className="stack-section-title">Stacks</div>
              <div className="toolbar library-toolbar stacks-toolbar">
                <button type="button" className="btn btn-primary btn-block" onClick={() => void newStack()}>
                  + New Stack
                </button>
              </div>
              {stacks.length === 0 && notebooks.length === 0 ? (
                <p className="library-hint muted">
                  Add a stack here (optional), then create notebooks in the next column.
                </p>
              ) : (
                <ul className="stack-picker-list" role="list">
                  <li className="stack-picker-item">
                    <button
                      type="button"
                      className={`stack-picker-select${libraryStackId === null ? " active" : ""}`}
                      onClick={() => {
                        libraryFilterUserChosenRef.current = true;
                        setLibraryStackId(null);
                      }}
                    >
                      <span className="stack-picker-name">Ungrouped</span>
                    </button>
                  </li>
                  {stacksSorted.map((stack) => (
                    <li key={stack.id} className="stack-picker-item">
                      <button
                        type="button"
                        className={`stack-picker-select${
                          libraryStackId === stack.id ? " active" : ""
                        }`}
                        onClick={() => {
                          libraryFilterUserChosenRef.current = true;
                          setLibraryStackId(stack.id);
                        }}
                      >
                        <span className="stack-picker-name" title={stack.name}>
                          {stack.name}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-tiny danger stack-picker-remove"
                        aria-label={`Remove stack ${stack.name}`}
                        onClick={() => void removeStack(stack.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </aside>

        <aside className="notebooks-panel" aria-label="Notebooks">
          {!isMobile && (
            <div className="panel-collapse-row">
              {libraryCollapsed ? (
                <button
                  type="button"
                  className="panel-collapse-toggle"
                  onClick={() => setLibraryCollapsed(false)}
                  aria-label="Expand stacks and notebooks"
                  title="Expand stacks and notebooks"
                >
                  »
                </button>
              ) : (
                <button
                  type="button"
                  className="panel-collapse-toggle"
                  onClick={() => setLibraryCollapsed(true)}
                  aria-label="Collapse stacks and notebooks"
                  title="Collapse stacks and notebooks"
                >
                  «
                </button>
              )}
            </div>
          )}
          {!libraryCollapsed || isMobile ? (
            <>
              <div className="stack-section-title">Notebooks</div>
              <div className="notebooks-column-context" title={selectedStackLabel}>
                {selectedStackLabel}
              </div>
              <div className="toolbar library-toolbar">
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  onClick={() => void newNotebookInStack(libraryStackId)}
                >
                  + Notebook
                </button>
              </div>
              {stacks.length === 0 && notebooks.length === 0 ? (
                <>
                  <p className="library-hint muted">
                    Create a stack (optional) in the left column, then add your first notebook here.
                  </p>
                  <button
                    type="button"
                    className="library-add-notebook"
                    onClick={() => void newNotebookInStack(null)}
                  >
                    + Add notebook
                  </button>
                </>
              ) : (
                <>
                  <ul className="nb-list notebooks-column-list" role="list">
                    {notebooksForLibraryColumn.length === 0 ? (
                      <li className="muted empty-inline">
                        {libraryStackId === null
                          ? "No ungrouped notebooks. Use + Notebook or pick a stack."
                          : "No notebooks in this stack yet. Use + Notebook."}
                      </li>
                    ) : (
                      notebooksForLibraryColumn.map((nb) => renderNotebookButton(nb))
                    )}
                  </ul>
                  <button
                    type="button"
                    className="library-add-notebook"
                    onClick={() => void newNotebookInStack(libraryStackId)}
                  >
                    + Add notebook
                  </button>
                </>
              )}
            </>
          ) : null}
        </aside>
      </div>

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
                    setNotebookListMenuOpenId(null);
                    setNotebookPanelMenuOpen((v) => !v);
                  }}
                >
                  ⋯
                </button>
                {notebookPanelMenuOpen && activeNotebook && (
                  <ul className="note-actions-menu" role="menu">
                    {stacksSorted.length === 0 ? (
                      <li role="none">
                        <span
                          className="note-actions-menu-item"
                          style={{ cursor: "default", opacity: 0.8 }}
                        >
                          No stacks — use + New Stack in the library
                        </span>
                      </li>
                    ) : (
                      stacksSorted.map((st) =>
                        st.id !== normalizedNotebookStackId(activeNotebook) ? (
                          <li key={st.id} role="none">
                            <button
                              type="button"
                              role="menuitem"
                              className="note-actions-menu-item"
                              onClick={() => {
                                setNotebookPanelMenuOpen(false);
                                void moveNotebookToStack(activeNotebook, st.id);
                              }}
                            >
                              {normalizedNotebookStackId(activeNotebook)
                                ? `Move to ${st.name}`
                                : `Add to ${st.name}`}
                            </button>
                          </li>
                        ) : null
                      )
                    )}
                    {normalizedNotebookStackId(activeNotebook) != null ? (
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="note-actions-menu-item"
                          onClick={() => {
                            setNotebookPanelMenuOpen(false);
                            void moveNotebookToStack(activeNotebook, null);
                          }}
                        >
                          Move to Ungrouped
                        </button>
                      </li>
                    ) : null}
                    {aiTierActive && (
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="note-actions-menu-item"
                          onClick={() => void runOrganizeSuggestions()}
                        >
                          Organize with AI…
                        </button>
                      </li>
                    )}
                    <li role="none" className="note-actions-menu-divider-before">
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
                          setNotebookListMenuOpenId(null);
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
                          {aiTierActive && (
                            <>
                              <li role="none">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="note-actions-menu-item"
                                  onClick={() => void openSimilarForNote(n.id, "notebook", n.title)}
                                >
                                  Similar in this notebook…
                                </button>
                              </li>
                              <li role="none">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="note-actions-menu-item"
                                  onClick={() => void openSimilarForNote(n.id, "all", n.title)}
                                >
                                  Similar in all notebooks…
                                </button>
                              </li>
                            </>
                          )}
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
        {activeNote && localBodyBackupHint && (
          <div className="note-backup-hint" role="status">
            <p className="note-backup-hint-text">
              This note is empty in your account, but this browser kept a local copy from{" "}
              <time dateTime={localBodyBackupHint.savedAt}>
                {new Date(localBodyBackupHint.savedAt).toLocaleString()}
              </time>
              . You can restore it to the server or discard the local copy.
            </p>
            <div className="note-backup-hint-actions">
              <button
                type="button"
                className="btn btn-primary btn-tiny"
                onClick={() => void restoreFromLocalBodyBackup()}
              >
                Restore from this device
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={dismissLocalBodyBackup}
              >
                Ignore backup
              </button>
            </div>
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
              <div className="note-menu-anchor editor-ai-menu">
                <button
                  type="button"
                  className={`btn btn-ghost${aiToolbarOpen ? " is-active" : ""}`}
                  disabled={!activeNote}
                  title={
                    !activeNote
                      ? undefined
                      : !aiTierActive
                        ? "AI tier not enabled — with Stripe checkout on, use Firestore plan=ai or DEV_GRANT_AI=1"
                        : "AI tools"
                  }
                  aria-expanded={aiToolbarOpen}
                  aria-haspopup="true"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!activeNote) return;
                    if (!aiTierActive) {
                      setErr(
                        "AI tier is not enabled. With billing/checkout enabled, set users.plan to \"ai\" in Firestore or DEV_GRANT_AI=1 / AI_TIER_BYPASS_EMAILS on the API."
                      );
                      return;
                    }
                    setNotebookPanelMenuOpen(false);
                    setNoteMenuOpenId(null);
                    setNotebookListMenuOpenId(null);
                    setEditorNoteMenuOpen(false);
                    setAiToolbarOpen((v) => !v);
                  }}
                >
                  AI ▾
                </button>
                {aiToolbarOpen && activeNote && aiTierActive && (
                  <ul className="note-actions-menu" role="menu">
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="note-actions-menu-item"
                        onClick={() => void runCleanupPreview()}
                      >
                        Cleanup note…
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="note-actions-menu-item"
                        onClick={() => {
                          setAiToolbarOpen(false);
                          void openSimilarForNote(
                            activeNote.id,
                            "all",
                            activeNote.title
                          );
                        }}
                      >
                        Consolidate notes…
                      </button>
                    </li>
                  </ul>
                )}
              </div>
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
                    setNotebookListMenuOpenId(null);
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
                    {aiTierActive && (
                      <>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="note-actions-menu-item"
                            onClick={() =>
                              void openSimilarForNote(
                                activeNote.id,
                                "notebook",
                                activeNote.title
                              )
                            }
                          >
                            Similar in this notebook…
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="note-actions-menu-item"
                            onClick={() =>
                              void openSimilarForNote(activeNote.id, "all", activeNote.title)
                            }
                          >
                            Similar in all notebooks…
                          </button>
                        </li>
                      </>
                    )}
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
            <div className="editor-body">
              <EditorContent editor={editor} className="editor-body-tiptap" />
            </div>
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

      {aiCleanupReview && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setAiCleanupReview(null)}
        >
          <div
            className="modal ai-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-cleanup-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="ai-cleanup-title" style={{ marginTop: 0 }}>
              Cleanup note
            </h3>
            <p className="muted">
              Review spelling, wording, and formatting changes. Green adds, red removes (plain-text
              view). Approve only if you are happy to replace the note body.
            </p>
            <TextDiffPanel
              before={aiCleanupReview.beforeText}
              after={aiCleanupReview.afterText}
            />
            <div className="ai-compare-row">
              <div className="ai-compare-col">
                <h4 className="ai-compare-heading">Current</h4>
                <div
                  className="ai-note-html-preview ai-modal-preview"
                  dangerouslySetInnerHTML={{ __html: aiCleanupReview.beforeHtml }}
                />
              </div>
              <div className="ai-compare-col">
                <h4 className="ai-compare-heading">Proposed</h4>
                <div
                  className="ai-note-html-preview ai-modal-preview"
                  dangerouslySetInnerHTML={{
                    __html: normalizeNoteHtmlForPreview(aiCleanupReview.afterHtml),
                  }}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setAiCleanupReview(null)}
              >
                Reject
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (!editor || !activeNote) return;
                  const html = normalizeTaskListHtmlForEditor(aiCleanupReview.afterHtml);
                  editor.commands.setContent(html, false);
                  void persist(activeNote.id, titleRef.current, html);
                  setAiCleanupReview(null);
                }}
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}

      {aiSimilar && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            setEmptyNotesDeleteSelected({});
            setAiSimilar(null);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-similar-title"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 620 }}
          >
            <h3 id="ai-similar-title" style={{ marginTop: 0 }}>
              Consolidate notes
            </h3>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>
              Notes similar to “{aiSimilar.sourceTitle}” ·{" "}
              {aiSimilar.scope === "notebook" ? "This notebook only" : "All your notebooks"}.
              Suggestions use shared <strong>content</strong> (not just the title). Check the notes
              you want to merge into one primary note, then preview.
            </p>

            {aiSimilar.emptyNotes.length > 0 && (
              <div style={{ marginBottom: "1.25rem" }}>
                <h4
                  style={{
                    margin: "0 0 0.35rem",
                    fontSize: "0.95rem",
                    fontWeight: 600,
                  }}
                >
                  Empty notes
                </h4>
                <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
                  Review the body preview for each note. Check only the ones you want to delete, then
                  confirm.
                </p>
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    marginBottom: "0.5rem",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="link-button"
                    style={{ fontSize: "0.85rem" }}
                    onClick={() =>
                      setEmptyNotesDeleteSelected((prev) => {
                        const next = { ...prev };
                        for (const en of aiSimilar.emptyNotes) next[en.id] = true;
                        return next;
                      })
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    style={{ fontSize: "0.85rem" }}
                    onClick={() =>
                      setEmptyNotesDeleteSelected((prev) => {
                        const next = { ...prev };
                        for (const en of aiSimilar.emptyNotes) next[en.id] = false;
                        return next;
                      })
                    }
                  >
                    Clear selection
                  </button>
                </div>
                <ul
                  className="consolidate-empty-list"
                  style={{ listStyle: "none", padding: 0, margin: "0 0 0.75rem", maxHeight: "22rem", overflow: "auto" }}
                >
                  {aiSimilar.emptyNotes.map((en) => (
                    <li
                      key={en.id}
                      style={{
                        borderBottom: "1px solid var(--border, #e5e7eb)",
                        padding: "0.5rem 0",
                      }}
                    >
                      <label
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          alignItems: "flex-start",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={emptyNotesDeleteSelected[en.id] ?? false}
                          onChange={(e) =>
                            setEmptyNotesDeleteSelected((prev) => ({
                              ...prev,
                              [en.id]: e.target.checked,
                            }))
                          }
                          aria-label={`Select ${en.title} for deletion`}
                        />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <strong>{en.title}</strong>
                          <div className="consolidate-empty-body-preview">
                            {(en.bodyPreview ?? "").length > 0
                              ? en.bodyPreview
                              : "(No body text)"}
                          </div>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn-ghost danger"
                  disabled={
                    aiSimilar.emptyNotes.filter(
                      (en) => emptyNotesDeleteSelected[en.id]
                    ).length === 0
                  }
                  onClick={() => void deleteEmptySuggestedNotes()}
                >
                  Delete selected…
                </button>
              </div>
            )}

            {aiSimilar.candidates.length > 0 ? (
              <>
                <label className="muted" style={{ display: "block", marginBottom: "0.35rem" }}>
                  Primary note (kept after merge)
                </label>
                <select
                  className="input"
                  style={{ marginBottom: "1rem" }}
                  value={mergePrimaryId}
                  onChange={(e) => setMergePrimaryId(e.target.value)}
                  aria-label="Primary note for merge"
                >
                  {[aiSimilar.noteId, ...aiSimilar.candidates.map((c) => c.id)]
                    .filter((id, i, a) => a.indexOf(id) === i)
                    .map((id) => (
                      <option key={id} value={id}>
                        {id === aiSimilar.noteId
                          ? `${aiSimilar.sourceTitle} (source)`
                          : `${aiSimilar.candidates.find((c) => c.id === id)?.title ?? id}`}
                      </option>
                    ))}
                </select>
                <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.5rem" }}>
                  Higher scores mean more overlapping meaningful words in the note body. Only strong
                  matches are pre-checked.
                </p>
                <ul className="ai-similar-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {aiSimilar.candidates.map((c) => (
                    <li
                      key={c.id}
                      style={{
                        borderBottom: "1px solid var(--border, #e5e7eb)",
                        padding: "0.5rem 0",
                      }}
                    >
                      <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                        <input
                          type="checkbox"
                          checked={similarSelected[c.id] ?? false}
                          onChange={(e) =>
                            setSimilarSelected((prev) => ({
                              ...prev,
                              [c.id]: e.target.checked,
                            }))
                          }
                        />
                        <span>
                          <strong>{c.title || "Untitled"}</strong>
                          <div className="muted" style={{ fontSize: "0.85rem" }}>
                            Score {(c.score * 100).toFixed(0)}% · {c.reason}
                          </div>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted" style={{ marginBottom: "1rem" }}>
                No other notes look similar enough in <strong>content</strong> to suggest merging.
                Try a note with more unique text, or narrow scope to one notebook.
              </p>
            )}

            <div className="modal-actions" style={{ marginTop: "1rem" }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setEmptyNotesDeleteSelected({});
                  setAiSimilar(null);
                }}
              >
                Close
              </button>
              {aiSimilar.candidates.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void runMergePreviewFromSimilar()}
                >
                  Preview merge
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {aiMerge && (
        <div className="modal-backdrop" role="presentation" onClick={() => setAiMerge(null)}>
          <div
            className="modal ai-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-merge-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="ai-merge-title" style={{ marginTop: 0 }}>
              Merge preview
            </h3>
            <p className="muted">
              Compare the primary note’s body to the merged result. Reject to adjust your selection;
              approve to save the primary and remove merged notes.
            </p>
            {aiMerge.warnings.length > 0 && (
              <ul className="muted" style={{ fontSize: "0.9rem" }}>
                {aiMerge.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <TextDiffPanel before={aiMerge.beforeText} after={aiMerge.afterText} />
            <div className="ai-compare-row">
              <div className="ai-compare-col">
                <h4 className="ai-compare-heading">Primary (current)</h4>
                <div
                  className="ai-note-html-preview ai-modal-preview"
                  dangerouslySetInnerHTML={{ __html: aiMerge.beforeHtml }}
                />
              </div>
              <div className="ai-compare-col">
                <h4 className="ai-compare-heading">Merged (proposed)</h4>
                <div
                  className="ai-note-html-preview ai-modal-preview"
                  dangerouslySetInnerHTML={{
                    __html: normalizeNoteHtmlForPreview(aiMerge.mergedHtml),
                  }}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setAiMerge(null)}>
                Reject
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void commitMerge()}>
                Approve merge
              </button>
            </div>
          </div>
        </div>
      )}

      {aiOrganize && (
        <div className="modal-backdrop" role="presentation" onClick={() => setAiOrganize(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-org-title"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <h3 id="ai-org-title" style={{ marginTop: 0 }}>
              Notebook suggestions
            </h3>
            <p className="muted">
              Accept moves you agree with. Nothing changes until you apply.
            </p>
            {aiOrganize.suggestions.length === 0 ? (
              <p className="muted">No moves suggested for this notebook.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
                {aiOrganize.suggestions.map((s) => {
                  const nbName =
                    notebooks.find((b) => b.id === s.suggestedNotebookId)?.name ??
                    s.suggestedNotebookId;
                  const noteTitle =
                    notesSorted.find((n) => n.id === s.noteId)?.title?.trim() || "Untitled";
                  return (
                    <li
                      key={s.noteId}
                      style={{
                        borderBottom: "1px solid var(--border, #e5e7eb)",
                        padding: "0.5rem 0",
                      }}
                    >
                      <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                        <input
                          type="checkbox"
                          checked={aiOrganize.accepted[s.noteId] ?? false}
                          onChange={(e) =>
                            setAiOrganize((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    accepted: {
                                      ...prev.accepted,
                                      [s.noteId]: e.target.checked,
                                    },
                                  }
                                : prev
                            )
                          }
                        />
                        <span>
                          <strong>{noteTitle}</strong>
                          <div style={{ fontSize: "0.9rem" }}>
                            → <em>{nbName}</em> ({Math.round(s.confidence * 100)}%)
                          </div>
                          <div className="muted" style={{ fontSize: "0.85rem" }}>
                            {s.reason}
                          </div>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setAiOrganize(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={aiOrganize.suggestions.length === 0}
                onClick={() => void applyOrganize()}
              >
                Apply accepted
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
