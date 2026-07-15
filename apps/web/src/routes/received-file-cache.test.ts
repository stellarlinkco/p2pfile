import { afterEach, expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import {
  cacheActiveReceiveProgress,
  clearCachedActiveReceiveProgress,
  readCachedActiveReceiveProgress,
} from "./received-file-cache";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

const manifest = [
  {
    id: "large-1",
    name: "large.zip",
    size: MANIFEST_CHUNK_BYTES * 4,
    mimeType: "application/zip",
  },
];

function installMemoryLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

function withBlockedLocalStorage(run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage blocked");
    },
  });
  try {
    run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
}

test("active receive progress cache is best-effort when localStorage is blocked", () => {
  withBlockedLocalStorage(() => {
    expect(() =>
      cacheActiveReceiveProgress("session-active", manifest, "large-1", MANIFEST_CHUNK_BYTES),
    ).not.toThrow();
    expect(readCachedActiveReceiveProgress("session-active", manifest)).toEqual(new Map());
    expect(() => clearCachedActiveReceiveProgress("session-active")).not.toThrow();
  });
});

test("active receive progress preserves an unaligned durable EOF", () => {
  installMemoryLocalStorage();
  const durableEof = MANIFEST_CHUNK_BYTES * 17 + 1;
  const unalignedManifest = [
    {
      id: "large-1",
      name: "large.zip",
      size: durableEof,
      mimeType: "application/zip",
    },
  ];

  cacheActiveReceiveProgress("session-active", unalignedManifest, "large-1", durableEof);

  expect(readCachedActiveReceiveProgress("session-active", unalignedManifest)).toEqual(
    new Map([["large-1", durableEof]]),
  );
});
