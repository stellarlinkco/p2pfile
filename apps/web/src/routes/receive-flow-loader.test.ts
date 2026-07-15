import { afterEach, expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES, manifestHash } from "@p2pfile/shared";
import { clearReceiverToken, writeReceiverToken } from "../lib/session-storage";
import { loadReceiverSession, type ReceiveSessionLoaderContext } from "./receive-flow-loader";
import type { ReceiverStage } from "./receive-flow-utils";

const originalFetch = globalThis.fetch;

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
  clearReceiverToken("abcdefabcdef");
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

const signalSessionPayload = (
  state: "claimed" | "connecting" | "failed" | "completed-view" | "reconnecting" | "transferring",
) => ({
  sessionId: "abcdefabcdef",
  state,
  manifest: [{ id: "file-1", name: "hello.txt", size: MANIFEST_CHUNK_BYTES * 32 }],
  summary: { fileCount: 1, totalSize: MANIFEST_CHUNK_BYTES * 32 },
  transferMode: "direct",
  canClaim: false,
  claimed:
    state === "claimed" ||
    state === "connecting" ||
    state === "reconnecting" ||
    state === "transferring",
  completed: state === "completed-view",
  ended: false,
  expiresAt: state === "completed-view" || state === "reconnecting" ? Date.now() + 120_000 : null,
  retriesRemaining: 2,
});

const stubResponses = (responses: unknown[]) => {
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = String(input).endsWith("/receiver-token")
      ? { valid: true }
      : responses[Math.min(call++, responses.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
};

function installReceiverToken(sessionId: string) {
  const tokenStorage = {
    getItem() {
      return null;
    },
    removeItem() {},
    setItem() {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: tokenStorage,
      location: { origin: "http://127.0.0.1:3001" },
    },
  });
  writeReceiverToken(sessionId, "receiver-token-receiver-token");
}

const createContext = () => {
  const stages: ReceiverStage[] = [];
  const statuses: string[] = [];
  const retries: Array<number | null> = [];
  const receivedFiles: Array<{ id: string; name: string; size: number }[]> = [];
  const progress: unknown[] = [];
  const context: ReceiveSessionLoaderContext = {
    navigate() {},
    setSession() {},
    setProgress(nextProgress) {
      progress.push(nextProgress);
    },
    setMode() {},
    setStage(stage) {
      stages.push(stage);
    },
    setStatus(status) {
      statuses.push(status);
    },
    setError() {},
    setRetriesRemaining(value) {
      retries.push(value);
    },
    setReceivedFiles(files) {
      receivedFiles.push(files);
    },
  };
  return { context, stages, statuses, retries, receivedFiles, progress };
};

test("visitor loading a failed session gets retry-exhausted guidance", async () => {
  stubResponses([signalSessionPayload("failed")]);
  const { context, stages, statuses } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("retry-exhausted");
  expect(statuses.at(-1)).toContain("请发送方重新创建会话");
});

test("original receiver re-entry surfaces retry budget without consuming it", async () => {
  installReceiverToken("abcdefabcdef");
  stubResponses([signalSessionPayload("claimed")]);
  const { context, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(retries.at(-1)).toBe(2);
});

test("original receiver re-entry restores retry budget after sender reconnects", async () => {
  installReceiverToken("abcdefabcdef");
  stubResponses([signalSessionPayload("transferring")]);
  const { context, stages, statuses, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(retries.at(-1)).toBe(2);
  expect(stages.at(-1)).toBe("manifest");
  expect(statuses.at(-1)).toContain("Frozen Manifest");
});

test("original receiver loading reconnecting session keeps same Share Link retry path", async () => {
  installReceiverToken("abcdefabcdef");
  stubResponses([signalSessionPayload("reconnecting")]);
  const { context, stages, statuses, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("reconnecting");
  expect(statuses.at(-1)).toContain("等待发送方重新连接");
  expect(retries.at(-1)).toBe(2);
});

test("original receiver loading reconnecting session preserves cached active progress", async () => {
  installReceiverToken("abcdefabcdef");
  const manifest = signalSessionPayload("reconnecting").manifest;
  const storage = new Map<string, string>();
  storage.set(
    "p2pfile-active-progress:abcdefabcdef",
    JSON.stringify({
      manifestHash: manifestHash(manifest),
      fileId: "file-1",
      committedBytes: MANIFEST_CHUNK_BYTES * 2,
      files: [{ fileId: "file-1", committedBytes: MANIFEST_CHUNK_BYTES * 2 }],
    }),
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      removeItem(key: string) {
        storage.delete(key);
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
    },
  });
  stubResponses([signalSessionPayload("reconnecting")]);
  const { context, progress } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(progress.at(-1)).toMatchObject({
    fileId: "file-1",
    fileBytes: MANIFEST_CHUNK_BYTES * 2,
    completedBytes: MANIFEST_CHUNK_BYTES * 2,
    files: [
      {
        fileId: "file-1",
        fileBytes: MANIFEST_CHUNK_BYTES * 2,
        state: "reconnecting",
      },
    ],
  });
});

test("original receiver can re-open a completed session view", async () => {
  stubResponses([
    signalSessionPayload("completed-view"),
    {
      status: "completed",
      originalReceiver: true,
      session: signalSessionPayload("completed-view"),
    },
  ]);
  const { context, stages, statuses, receivedFiles } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("completed");
  expect(statuses.at(-1)).toContain("Completed Session View");
  expect(receivedFiles.at(-1)).toEqual([]);
});

test("non-owning visitors to completed sessions get only Completion Notice", async () => {
  stubResponses([
    signalSessionPayload("completed-view"),
    {
      status: "completed",
      originalReceiver: false,
      session: signalSessionPayload("completed-view"),
    },
  ]);
  const { context, stages, statuses, receivedFiles } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("completion-notice");
  expect(statuses.at(-1)).toContain("Completion Notice");
  expect(receivedFiles.at(-1)).toEqual([]);
});

test("owner re-entry for transferring session loads metadata without claiming or consuming retries", async () => {
  const sessionId = "abcdefabcdef";
  const requestLog: Array<{ method: string; url: string }> = [];
  installReceiverToken(sessionId);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requestLog.push({ method: (init?.method ?? "GET").toUpperCase(), url });
    const body = url.endsWith("/receiver-token")
      ? { valid: true }
      : signalSessionPayload("transferring");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const { context, stages, statuses, retries } = createContext();

  await loadReceiverSession(sessionId, false, context);

  expect(requestLog.map((entry) => entry.method)).toEqual(["GET", "GET"]);
  expect(requestLog.every((entry) => !entry.url.includes("/claim"))).toBe(true);
  expect(requestLog[0]?.url).toContain(`/api/sessions/${sessionId}`);
  expect(retries.at(-1)).toBe(2);
  expect(stages.at(-1)).toBe("manifest");
  expect(statuses.at(-1)).toContain("Frozen Manifest");
});

test("tokenless visitor to transferring session receives occupied guidance", async () => {
  stubResponses([signalSessionPayload("transferring")]);
  const { context, stages, statuses, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("occupied");
  expect(statuses.at(-1)).toContain("Occupied Session Notice");
  expect(retries.at(-1)).toBeNull();
});

test("tokenless visitor to connecting session receives occupied guidance", async () => {
  stubResponses([signalSessionPayload("connecting")]);
  const { context, stages, statuses, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("occupied");
  expect(statuses.at(-1)).toContain("Occupied Session Notice");
  expect(retries.at(-1)).toBeNull();
});

test("stale receiver token sees occupied notice after another receiver claims", async () => {
  const sessionId = "abcdefabcdef";
  installReceiverToken(sessionId);
  const requestUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestUrls.push(url);
    const body = url.endsWith("/receiver-token")
      ? { valid: false }
      : signalSessionPayload("transferring");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const { context, stages, statuses, retries } = createContext();

  await loadReceiverSession(sessionId, false, context);

  expect(requestUrls.some((url) => url.endsWith("/receiver-token"))).toBe(true);
  expect(stages.at(-1)).toBe("occupied");
  expect(statuses.at(-1)).toContain("Occupied Session Notice");
  expect(retries.at(-1)).toBeNull();
});

test("owner re-entry for reconnecting session loads metadata without consuming retry", async () => {
  const sessionId = "abcdefabcdef";
  const requestMethods: string[] = [];
  installReceiverToken(sessionId);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestMethods.push((init?.method ?? "GET").toUpperCase());
    const body = String(input).endsWith("/receiver-token")
      ? { valid: true }
      : signalSessionPayload("reconnecting");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const { context, stages, retries } = createContext();

  await loadReceiverSession(sessionId, false, context);

  expect(requestMethods).toEqual(["GET", "GET"]);
  expect(retries.at(-1)).toBe(2);
  expect(stages.at(-1)).toBe("reconnecting");
});
