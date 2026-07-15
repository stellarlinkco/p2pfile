import { afterEach, expect, test } from "bun:test";
import { type FileManifestItem, MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import type { ReceivedFile } from "../lib/transfer";
import { receiverStageFromRuntimeStatus, resumeCommittedBytesByFileId } from "./receive-flow-claim";
import { cacheActiveReceiveProgress } from "./received-file-cache";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installMemoryLocalStorage() {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("sender reconnect signal preserves a live receiving runtime stage", () => {
  expect(receiverStageFromRuntimeStatus("receiving", "Waiting for peer reconnect", true)).toBe(
    "receiving",
  );
  expect(receiverStageFromRuntimeStatus("connecting", "Waiting for peer reconnect", true)).toBe(
    "reconnecting",
  );
  expect(receiverStageFromRuntimeStatus("receiving", "Waiting for peer reconnect", false)).toBe(
    "reconnecting",
  );
});

test("connected transport status enters receiving before first progress", () => {
  expect(receiverStageFromRuntimeStatus("connecting", "Direct Transfer connected", true)).toBe(
    "receiving",
  );
  expect(receiverStageFromRuntimeStatus("connecting", "Direct Transfer connected", false)).toBe(
    "connecting",
  );
  expect(receiverStageFromRuntimeStatus("connecting", "Relayed Transfer connected", true)).toBe(
    "receiving",
  );
  expect(receiverStageFromRuntimeStatus("connecting", "Relayed Transfer connected", false)).toBe(
    "receiving",
  );
});

test("replacement status removes a superseded receiver from the active stage", () => {
  expect(receiverStageFromRuntimeStatus("connecting", "Receiver connection replaced", false)).toBe(
    "occupied",
  );
});

test("resume committed bytes composes completed cached files with active committed progress", () => {
  installMemoryLocalStorage();
  const manifest: FileManifestItem[] = [
    {
      id: "done-1",
      name: "done.txt",
      size: 128,
      mimeType: "text/plain",
    },
    {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 32,
      mimeType: "application/zip",
    },
  ];
  const completedManifestItem = manifest[0];
  const activeManifestItem = manifest[1];
  if (!completedManifestItem || !activeManifestItem)
    throw new Error("Expected two manifest items.");
  const completedFile: ReceivedFile = {
    id: completedManifestItem.id,
    name: completedManifestItem.name,
    size: completedManifestItem.size,
    blob: new Blob(["done"], { type: completedManifestItem.mimeType }),
    url: "blob:done-1",
  };

  cacheActiveReceiveProgress(
    "session-mixed",
    manifest,
    activeManifestItem.id,
    MANIFEST_CHUNK_BYTES * 2,
  );

  const committedBytesByFileId = resumeCommittedBytesByFileId("session-mixed", manifest, [
    completedFile,
  ]);
  expect(committedBytesByFileId.get(completedManifestItem.id)).toBe(completedManifestItem.size);
  expect(committedBytesByFileId.get(activeManifestItem.id)).toBe(MANIFEST_CHUNK_BYTES * 2);
});
