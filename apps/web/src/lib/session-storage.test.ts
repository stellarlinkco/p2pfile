import { afterEach, expect, test } from "bun:test";
import { clearReceiverToken, readReceiverToken, writeReceiverToken } from "./session-storage";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("receiver token falls back to in-memory storage when localStorage writes fail", () => {
  const sessionId = `session-${crypto.randomUUID()}`;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error("storage blocked");
        },
        removeItem() {
          throw new Error("storage blocked");
        },
      },
    },
  });

  writeReceiverToken(sessionId, "receiver-token");
  expect(readReceiverToken(sessionId)).toBe("receiver-token");

  clearReceiverToken(sessionId);
  expect(readReceiverToken(sessionId)).toBeNull();
});
