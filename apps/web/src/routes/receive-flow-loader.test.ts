import { afterEach, expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES, manifestHash } from "@p2pfile/shared";
import { loadReceiverSession, type ReceiveSessionLoaderContext } from "./receive-flow-loader";
import type { ReceiverStage } from "./receive-flow-utils";

const originalFetch = globalThis.fetch;

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

const signalSessionPayload = (state: "claimed" | "failed" | "completed-view" | "reconnecting") => ({
  sessionId: "abcdefabcdef",
  state,
  manifest: [{ id: "file-1", name: "hello.txt", size: MANIFEST_CHUNK_BYTES * 32 }],
  summary: { fileCount: 1, totalSize: MANIFEST_CHUNK_BYTES * 32 },
  transferMode: "direct",
  canClaim: false,
  claimed: state === "claimed" || state === "reconnecting",
  completed: state === "completed-view",
  ended: false,
  expiresAt: state === "completed-view" || state === "reconnecting" ? Date.now() + 120_000 : null,
  retriesRemaining: 2,
});

const stubResponses = (responses: unknown[]) => {
  let call = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
};

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

test("original receiver re-entry surfaces the remaining retry budget", async () => {
  stubResponses([
    signalSessionPayload("claimed"),
    {
      status: "claimed",
      receiverToken: "receiver-token-receiver-token",
      retriesRemaining: 1,
      session: signalSessionPayload("claimed"),
    },
  ]);
  const { context, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(retries.at(-1)).toBe(1);
});

test("original receiver loading reconnecting session keeps same Share Link retry path", async () => {
  stubResponses([
    signalSessionPayload("reconnecting"),
    {
      status: "claimed",
      receiverToken: "receiver-token-receiver-token",
      retriesRemaining: 1,
      session: signalSessionPayload("reconnecting"),
    },
  ]);
  const { context, stages, statuses, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("reconnecting");
  expect(statuses.at(-1)).toContain("等待发送方重新连接");
  expect(retries.at(-1)).toBe(1);
});

test("original receiver loading reconnecting session preserves cached active progress", async () => {
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
  stubResponses([
    signalSessionPayload("reconnecting"),
    {
      status: "claimed",
      receiverToken: "receiver-token-receiver-token",
      retriesRemaining: 1,
      session: signalSessionPayload("reconnecting"),
    },
  ]);
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
