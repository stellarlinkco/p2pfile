import { type FileManifestItem, MANIFEST_CHUNK_BYTES, manifestHash } from "@p2pfile/shared";
import type { ReceivedFile } from "../lib/transfer";

const DB_NAME = "p2pfile-received-files";
const STORE_NAME = "files";
const DB_VERSION = 1;

type CachedFileRecord = {
  key: string;
  sessionId: string;
  index: number;
  id: string;
  name: string;
  size: number;
  blob: Blob;
};

function cacheKey(sessionId: string, index: number) {
  return `${sessionId}:${index}`;
}

const ACTIVE_PROGRESS_PREFIX = "p2pfile-active-progress";
const ACTIVE_PROGRESS_MIN_BYTES = 1024 * 1024;

type CachedActiveProgress = {
  manifestHash: string;
  fileId?: string;
  committedBytes?: number;
  files?: Array<{ fileId: string; committedBytes: number }>;
};

function activeProgressKey(sessionId: string) {
  return `${ACTIVE_PROGRESS_PREFIX}:${sessionId}`;
}

function activeProgressStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function openCache() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Received file cache unavailable."));
  }
  const { promise, reject, resolve } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Received file cache failed."));
  return promise;
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>) {
  return openCache().then(async (db) => {
    try {
      return await run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    } finally {
      db.close();
    }
  });
}

function requestDone<T>(request: IDBRequest<T>) {
  const { promise, reject, resolve } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Received file cache request failed."));
  return promise;
}

export async function cacheReceivedFile(sessionId: string, file: ReceivedFile, index: number) {
  await transact("readwrite", (store) =>
    requestDone(
      store.put({
        key: cacheKey(sessionId, index),
        sessionId,
        index,
        id: file.id,
        name: file.name,
        size: file.size,
        blob: file.blob,
      } satisfies CachedFileRecord),
    ),
  );
}

export async function readCachedReceivedFiles(sessionId: string, manifest: FileManifestItem[]) {
  return transact("readonly", async (store) => {
    const files: ReceivedFile[] = [];
    for (let index = 0; index < manifest.length; index += 1) {
      const record = await requestDone<CachedFileRecord | undefined>(
        store.get(cacheKey(sessionId, index)),
      );
      const expected = manifest[index];
      if (!record || !expected || record.id !== expected.id || record.size !== expected.size) {
        continue;
      }
      files.push({
        id: record.id,
        name: record.name,
        size: record.size,
        blob: record.blob,
        url: URL.createObjectURL(record.blob),
      });
    }
    return files;
  }).catch(() => []);
}

function parseActiveProgress(raw: string | null, expectedManifestHash: string) {
  const progress = new Map<string, number>();
  if (!raw) return progress;
  try {
    const parsed = JSON.parse(raw) as CachedActiveProgress;
    if (parsed.manifestHash !== expectedManifestHash) return progress;
    if (parsed.fileId && typeof parsed.committedBytes === "number") {
      progress.set(parsed.fileId, parsed.committedBytes);
    }
    for (const file of parsed.files ?? []) {
      progress.set(file.fileId, file.committedBytes);
    }
  } catch {
    return new Map<string, number>();
  }
  return progress;
}

function activeProgressEntries(
  manifest: FileManifestItem[],
  progress: ReadonlyMap<string, number>,
) {
  const entries: Array<{ fileId: string; committedBytes: number }> = [];
  for (const file of manifest) {
    const committedBytes = progress.get(file.id) ?? 0;
    if (
      file.size > ACTIVE_PROGRESS_MIN_BYTES &&
      committedBytes > 0 &&
      committedBytes <= file.size &&
      (committedBytes === file.size || committedBytes % MANIFEST_CHUNK_BYTES === 0)
    ) {
      entries.push({ fileId: file.id, committedBytes });
    }
  }
  return entries;
}

export function cacheActiveReceiveProgress(
  sessionId: string,
  manifest: FileManifestItem[],
  fileId: string | null,
  committedBytes: number,
) {
  const storage = activeProgressStorage();
  if (!storage || !fileId) return;
  const nextManifestHash = manifestHash(manifest);
  let raw: string | null;
  try {
    raw = storage.getItem(activeProgressKey(sessionId));
  } catch {
    return;
  }
  const progress = parseActiveProgress(raw, nextManifestHash);
  progress.set(fileId, committedBytes);
  const entries = activeProgressEntries(manifest, progress);
  if (entries.length === 0) {
    clearCachedActiveReceiveProgress(sessionId);
    return;
  }
  const primary = entries[0];
  try {
    storage.setItem(
      activeProgressKey(sessionId),
      JSON.stringify({
        manifestHash: nextManifestHash,
        fileId: primary?.fileId,
        committedBytes: primary?.committedBytes,
        files: entries,
      } satisfies CachedActiveProgress),
    );
  } catch {
    return;
  }
}

export function readCachedActiveReceiveProgress(sessionId: string, manifest: FileManifestItem[]) {
  const storage = activeProgressStorage();
  if (!storage) return new Map<string, number>();
  let raw: string | null;
  try {
    raw = storage.getItem(activeProgressKey(sessionId));
  } catch {
    return new Map<string, number>();
  }
  const progress = parseActiveProgress(raw, manifestHash(manifest));
  const entries = activeProgressEntries(manifest, progress);
  return new Map(entries.map((file) => [file.fileId, file.committedBytes]));
}

export function clearCachedActiveReceiveProgress(sessionId: string, fileId?: string) {
  const storage = activeProgressStorage();
  if (!storage) return;
  const key = activeProgressKey(sessionId);
  if (!fileId) {
    try {
      storage.removeItem(key);
    } catch {
      return;
    }
    return;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return;
  }
  try {
    const cached = raw ? (JSON.parse(raw) as CachedActiveProgress) : null;
    const parsed = parseActiveProgress(raw, cached?.manifestHash ?? "");
    parsed.delete(fileId);
    if (parsed.size === 0 || !cached) {
      storage.removeItem(key);
      return;
    }
    const files = [...parsed.entries()].map(([nextFileId, committedBytes]) => ({
      fileId: nextFileId,
      committedBytes,
    }));
    const primary = files[0];
    storage.setItem(
      key,
      JSON.stringify({
        manifestHash: cached.manifestHash,
        fileId: primary?.fileId,
        committedBytes: primary?.committedBytes,
        files,
      } satisfies CachedActiveProgress),
    );
  } catch {
    return;
  }
}

export async function clearCachedReceivedFiles(sessionId: string) {
  await transact("readwrite", async (store) => {
    const keys = await requestDone<IDBValidKey[]>(store.getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(`${sessionId}:`))
        .map((key) => requestDone(store.delete(key))),
    );
  }).catch(() => undefined);
  clearCachedActiveReceiveProgress(sessionId);
}
