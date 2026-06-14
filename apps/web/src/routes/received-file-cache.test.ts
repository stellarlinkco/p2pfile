import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import {
  cacheActiveReceiveProgress,
  clearCachedActiveReceiveProgress,
  readCachedActiveReceiveProgress,
} from "./received-file-cache";

const manifest = [
  {
    id: "large-1",
    name: "large.zip",
    size: MANIFEST_CHUNK_BYTES * 4,
    mimeType: "application/zip",
  },
];

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
