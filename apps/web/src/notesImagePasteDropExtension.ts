import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export function isLikelyImageFile(f: File): boolean {
  if (f.type.startsWith("image/")) return true;
  if (!f.type && /\.(png|jpe?g|gif|webp)$/i.test(f.name || "")) return true;
  return false;
}

export function collectClipboardImageFiles(event: ClipboardEvent): File[] {
  const cd = event.clipboardData;
  if (!cd) return [];
  const seen = new Set<string>();
  const out: File[] = [];
  const add = (file: File | null) => {
    if (!file || !isLikelyImageFile(file)) return;
    const k = `${file.size}:${file.type}:${file.name}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(file);
  };
  for (let i = 0; i < (cd.files?.length ?? 0); i++) {
    add(cd.files!.item(i));
  }
  for (const item of [...(cd.items ?? [])]) {
    if (item.kind === "file" && (item.type.startsWith("image/") || item.type === "")) {
      add(item.getAsFile());
    }
  }
  return out;
}

export type NotesImagePasteDropContext = {
  uploadFiles: (files: File[]) => void | Promise<void>;
};

/**
 * ProseMirror plugin (high priority) so paste/drop run reliably; TipTap `editorProps` alone can be ignored.
 */
export function createNotesImagePasteDropExtension(
  getCtx: () => NotesImagePasteDropContext
) {
  return Extension.create({
    name: "notesImagePasteDrop",
    priority: 10000,

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("notesImagePasteDrop"),
          props: {
            handleDOMEvents: {
              dragenter(_view, e) {
                const ev = e as DragEvent;
                const dt = ev.dataTransfer;
                if (!dt) return false;
                const hasFiles =
                  (dt.types && Array.from(dt.types).includes("Files")) ||
                  (dt.files && dt.files.length > 0);
                if (!hasFiles) return false;
                ev.preventDefault();
                dt.dropEffect = "copy";
                return false;
              },
              dragover(_view, e) {
                const ev = e as DragEvent;
                const dt = ev.dataTransfer;
                if (!dt) return false;
                const types = dt.types ? Array.from(dt.types) : [];
                const looksLikeFileDrop =
                  types.includes("Files") ||
                  (dt.files && dt.files.length > 0) ||
                  types.some(
                    (t) =>
                      t.startsWith("image/") ||
                      t === "public.file-url" ||
                      t === "public.png" ||
                      t === "public.jpeg" ||
                      t === "com.apple.pasteboard.promised-file-url"
                  );
                if (!looksLikeFileDrop) return false;
                ev.preventDefault();
                dt.dropEffect = "copy";
                return false;
              },
              drop(_view, e) {
                const ev = e as DragEvent;
                const dt = ev.dataTransfer;
                if (!dt?.files?.length) return false;
                const imageFiles = Array.from(dt.files).filter(isLikelyImageFile);
                if (!imageFiles.length) return false;
                ev.preventDefault();
                void getCtx().uploadFiles(imageFiles);
                return true;
              },
            },
            handlePaste(_view, event) {
              const files = collectClipboardImageFiles(event);
              if (!files.length) return false;
              event.preventDefault();
              void getCtx().uploadFiles(files);
              return true;
            },
            handleDrop(_view, event, _slice, moved) {
              if (moved) return false;
              const dt = event.dataTransfer;
              if (!dt?.files?.length) return false;
              const imageFiles = Array.from(dt.files).filter(isLikelyImageFile);
              if (!imageFiles.length) return false;
              event.preventDefault();
              void getCtx().uploadFiles(imageFiles);
              return true;
            },
          },
        }),
      ];
    },
  });
}
