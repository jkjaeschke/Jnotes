import {
  createWriteStream,
  createReadStream as fsCreateReadStream,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Storage } from "@google-cloud/storage";
import { config } from "../config.js";

let gcs: Storage | null = null;

function getGcs(): Storage | null {
  if (!config.gcsBucket) return null;
  if (!gcs) gcs = new Storage();
  return gcs;
}

export function usesGcs(): boolean {
  return Boolean(config.gcsBucket);
}

function localPath(key: string): string {
  return join(config.localDataDir, "blobs", key);
}

export async function saveUploadStream(
  key: string,
  stream: NodeJS.ReadableStream,
  contentType?: string
): Promise<void> {
  const bucket = getGcs();
  if (bucket) {
    const file = bucket.bucket(config.gcsBucket).file(key);
    await pipeline(
      stream,
      file.createWriteStream({ contentType: contentType ?? "application/octet-stream" })
    );
    return;
  }
  const dest = localPath(key);
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(stream, createWriteStream(dest));
}

export async function saveBuffer(
  key: string,
  body: Buffer,
  contentType?: string
): Promise<void> {
  await saveUploadStream(key, Readable.from(body), contentType);
}

export async function readObjectBuffer(key: string): Promise<Buffer> {
  const bucket = getGcs();
  if (bucket) {
    const [buf] = await bucket.bucket(config.gcsBucket).file(key).download();
    return buf;
  }
  return readFileSync(localPath(key));
}

export function createReadStreamSync(key: string): NodeJS.ReadableStream {
  const bucket = getGcs();
  if (bucket) {
    return bucket.bucket(config.gcsBucket).file(key).createReadStream();
  }
  return fsCreateReadStream(localPath(key));
}

export async function signedDownloadUrl(
  key: string,
  filename: string
): Promise<string> {
  const bucket = getGcs();
  if (bucket) {
    const [url] = await bucket
      .bucket(config.gcsBucket)
      .file(key)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + 15 * 60 * 1000,
        responseDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
      });
    return url;
  }
  return `/api/attachments/blob/${encodeURIComponent(key)}?name=${encodeURIComponent(filename)}`;
}

export function deleteObjectSync(key: string): void {
  const bucket = getGcs();
  if (bucket) {
    void bucket.bucket(config.gcsBucket).file(key).delete({ ignoreNotFound: true });
    return;
  }
  try {
    unlinkSync(localPath(key));
  } catch {
    /* ignore */
  }
}
