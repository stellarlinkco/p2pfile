import type { FileManifestItem } from "@p2pfile/shared";
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
      if (!record || !expected || record.id !== expected.id || record.size !== expected.size) break;
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

export async function clearCachedReceivedFiles(sessionId: string) {
  await transact("readwrite", async (store) => {
    const keys = await requestDone<IDBValidKey[]>(store.getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(`${sessionId}:`))
        .map((key) => requestDone(store.delete(key))),
    );
  }).catch(() => undefined);
}
