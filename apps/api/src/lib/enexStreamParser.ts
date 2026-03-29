import sax from "sax";
import type { Readable } from "node:stream";

export type ParsedResource = {
  mime: string;
  filename: string;
  data: Buffer;
};

export type ParsedNote = {
  title: string;
  content: string;
  created: Date | null;
  updated: Date | null;
  guid: string | null;
  resources: ParsedResource[];
};

function parseEvernoteDate(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  /** Evernote: 20251117T140659Z or 20251117T140659.123Z (no ISO dashes). */
  const m = t.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d{1,3})?Z$/i
  );
  if (m) {
    return new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6])
      )
    );
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

function attrLower(attributes: unknown, key: string): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const lower = key.toLowerCase();
  for (const k of Object.keys(attributes as object)) {
    if (k.toLowerCase() === lower) {
      const v = (attributes as Record<string, unknown>)[k];
      return typeof v === "object" && v !== null && "value" in v
        ? String((v as { value: string }).value)
        : String(v);
    }
  }
  return null;
}

/**
 * Stream-parse a single .enex file and await onNote for each <note> (input paused per note).
 */
export function parseEnexStream(
  input: Readable,
  onNote: (note: ParsedNote) => Promise<void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, {
      trim: false,
      normalize: false,
    });

    const stack: string[] = [];
    let depthNote = 0;
    let inResource = false;
    let inData = false;
    let dataEncoding: string | null = null;

    let title = "";
    let content = "";
    let createdRaw = "";
    let updatedRaw = "";
    let guid = "";
    let resources: ParsedResource[] = [];

    let currentMime = "";
    let currentFilename = "";
    let currentBase64 = "";
    /** Decoded bytes; flushed on `</resource>` so `<mime>` after `<data>` (Evernote v10) is included. */
    let pendingResourceData: Buffer | null = null;

    let captureTarget:
      | "title"
      | "content"
      | "created"
      | "updated"
      | "guid"
      | "mime"
      | "filename"
      | "data"
      | null = null;

    let textBuf = "";
    let ended = false;

    function fail(e: Error) {
      if (ended) return;
      ended = true;
      input.destroy();
      reject(e);
    }

    parser.on("opentag", (node: sax.Tag | sax.QualifiedTag) => {
      const name = String(node.name).toLowerCase();
      stack.push(name);

      if (name === "note") {
        depthNote += 1;
        if (depthNote === 1) {
          title = "";
          content = "";
          createdRaw = "";
          updatedRaw = "";
          guid = "";
          resources = [];
        }
      }

      if (depthNote === 1 && name === "resource") {
        inResource = true;
        currentMime = "";
        currentFilename = "";
        currentBase64 = "";
        pendingResourceData = null;
      }

      if (inResource && name === "data") {
        inData = true;
        const enc = attrLower(node.attributes, "encoding");
        dataEncoding = enc ? enc.toLowerCase() : null;
        currentBase64 = "";
        captureTarget = "data";
      }

      if (depthNote !== 1) return;

      if (!inResource) {
        if (name === "title") {
          captureTarget = "title";
          textBuf = "";
        } else if (name === "content") {
          captureTarget = "content";
          textBuf = "";
        } else if (name === "created") {
          captureTarget = "created";
          textBuf = "";
        } else if (name === "updated") {
          captureTarget = "updated";
          textBuf = "";
        } else if (
          name === "guid" &&
          stack.length >= 2 &&
          stack[stack.length - 2] === "note-attributes"
        ) {
          captureTarget = "guid";
          textBuf = "";
        }
      } else if (!inData) {
        if (name === "mime") {
          captureTarget = "mime";
          textBuf = "";
        } else if (name === "file-name") {
          captureTarget = "filename";
          textBuf = "";
        }
      }
    });

    parser.on("text", (t: string) => {
      if (captureTarget === "data" && inData) {
        currentBase64 += t;
        return;
      }
      if (captureTarget) textBuf += t;
    });

    parser.on("cdata", (c: string) => {
      if (captureTarget === "content") {
        textBuf += c;
        return;
      }
      if (captureTarget === "data" && inData) {
        currentBase64 += c;
        return;
      }
      if (captureTarget) textBuf += c;
    });

    parser.on("closetag", (name: string) => {
      const n = name.toLowerCase();

      if (captureTarget === "title" && n === "title") {
        title = textBuf.trim();
        captureTarget = null;
      } else if (captureTarget === "content" && n === "content") {
        content = textBuf;
        captureTarget = null;
      } else if (captureTarget === "created" && n === "created") {
        createdRaw = textBuf.trim();
        captureTarget = null;
      } else if (captureTarget === "updated" && n === "updated") {
        updatedRaw = textBuf.trim();
        captureTarget = null;
      } else if (captureTarget === "guid" && n === "guid") {
        guid = textBuf.trim();
        captureTarget = null;
      } else if (captureTarget === "mime" && n === "mime") {
        currentMime = textBuf.trim();
        captureTarget = null;
      } else if (captureTarget === "filename" && n === "file-name") {
        currentFilename = textBuf.trim();
        captureTarget = null;
      } else if (captureTarget === "data" && n === "data") {
        const raw = currentBase64.replace(/\s+/g, "");
        pendingResourceData = null;
        if (raw && dataEncoding === "base64") {
          try {
            pendingResourceData = Buffer.from(raw, "base64");
          } catch {
            pendingResourceData = null;
          }
        }
        inData = false;
        dataEncoding = null;
        captureTarget = null;
      }

      if (n === "resource" && inResource && depthNote === 1) {
        if (pendingResourceData) {
          resources.push({
            mime: currentMime || "application/octet-stream",
            filename: currentFilename || "attachment",
            data: pendingResourceData,
          });
        }
        pendingResourceData = null;
        currentMime = "";
        currentFilename = "";
        inResource = false;
      }

      if (n === "note") {
        if (depthNote === 1) {
          const note: ParsedNote = {
            title,
            content,
            created: parseEvernoteDate(createdRaw),
            updated: parseEvernoteDate(updatedRaw),
            guid: guid || null,
            resources,
          };
          input.pause();
          void onNote(note)
            .then(() => {
              if (!ended) input.resume();
            })
            .catch((e: Error) => fail(e));
        }
        depthNote = Math.max(0, depthNote - 1);
      }

      stack.pop();
    });

    parser.on("error", (e: Error) => fail(e));
    parser.on("end", () => {
      ended = true;
      resolve();
    });

    input.pipe(parser);
  });
}
