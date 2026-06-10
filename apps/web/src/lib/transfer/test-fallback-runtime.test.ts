import { expect, test } from "bun:test";
import type { FileManifestItem } from "@p2pfile/shared";
import {
  startReceiverTestFallbackRuntime,
  startSenderTestFallbackRuntime,
} from "./test-fallback-runtime";
import type {
  ReceivedFile,
  SenderRuntimeHandlers,
  TransferProgress,
  TransferProtocolMessage,
} from "./types";

async function sha256Hex(content: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function senderHandlersWith(overrides: Partial<SenderRuntimeHandlers>): SenderRuntimeHandlers {
  return {
    onStatus() {},
    onMode() {},
    onProgress() {},
    onComplete() {},
    onError() {},
    ...overrides,
  };
}

test("fallback sender file-end carries the file content digest", async () => {
  const sessionId = `session-${crypto.randomUUID()}`;
  const tap = new BroadcastChannel(`p2pfile:test:${sessionId}`);
  const fileEnd = Promise.withResolvers<TransferProtocolMessage>();
  const senderDone = Promise.withResolvers<void>();
  tap.onmessage = (event) => {
    const message = event.data as TransferProtocolMessage;
    if (message.type === "file-end") {
      fileEnd.resolve(message);
    }
  };

  const sender = await startSenderTestFallbackRuntime(
    sessionId,
    "sender-token",
    [new File(["alpha"], "alpha.txt", { type: "text/plain" })],
    [{ id: "file-1", name: "alpha.txt", size: 5 }],
    senderHandlersWith({
      onComplete() {
        senderDone.resolve();
      },
      onError(message) {
        senderDone.reject(new Error(message));
      },
    }),
  );
  tap.postMessage({ type: "receiver-ready", payload: { completedFiles: 0 } });

  try {
    const message = await fileEnd.promise;
    await senderDone.promise;
    expect(message).toMatchObject({
      fileId: "file-1",
      bytes: 5,
      digest: await sha256Hex("alpha"),
    });
  } finally {
    sender.stop();
    tap.close();
  }
});

test("receiver fallback restores progress from already received files", async () => {
  const receivedFiles: ReceivedFile[] = [
    {
      id: "file-1",
      name: "alpha.txt",
      size: 5,
      blob: new Blob(["alpha"]),
      url: "blob:alpha",
    },
  ];
  const progress: TransferProgress[] = [];

  const runtime = await startReceiverTestFallbackRuntime(
    `session-${crypto.randomUUID()}`,
    "receiver-token",
    [
      { id: "file-1", name: "alpha.txt", size: 5 },
      { id: "file-2", name: "beta.txt", size: 4 },
    ],
    {
      onComplete() {},
      onEnded() {},
      onError() {},
      onFileReceived() {},
      onMode() {},
      onProgress(nextProgress) {
        progress.push(nextProgress);
      },
      onStatus() {},
    },
    receivedFiles,
  );

  runtime.stop();

  expect(progress).toContainEqual({
    fileId: "file-2",
    fileName: "beta.txt",
    fileBytes: 0,
    fileTotalBytes: 4,
    completedBytes: 5,
    totalBytes: 9,
    completedFiles: 1,
    totalFiles: 2,
  });
});

test("sender fallback resumes from the receiver completed-file offset", async () => {
  const sessionId = `session-${crypto.randomUUID()}`;
  const manifest: FileManifestItem[] = [
    { id: "file-1", name: "alpha.txt", size: 5 },
    { id: "file-2", name: "beta.txt", size: 4 },
  ];
  const files = [
    new File(["alpha"], "alpha.txt", { type: "text/plain" }),
    new File(["beta"], "beta.txt", { type: "text/plain" }),
  ];
  const receivedFiles: ReceivedFile[] = [
    {
      id: "file-1",
      name: "alpha.txt",
      size: 5,
      blob: new Blob(["alpha"]),
      url: "blob:alpha",
    },
  ];
  const senderProgress: TransferProgress[] = [];
  const receiverErrors: string[] = [];
  const completion = Promise.withResolvers<void>();

  const sender = await startSenderTestFallbackRuntime(sessionId, "sender-token", files, manifest, {
    onComplete() {},
    onError(message) {
      completion.reject(new Error(message));
    },
    onMode() {},
    onProgress(nextProgress) {
      senderProgress.push(nextProgress);
    },
    onStatus() {},
  });
  const receiver = await startReceiverTestFallbackRuntime(
    sessionId,
    "receiver-token",
    manifest,
    {
      onComplete() {
        completion.resolve();
      },
      onEnded() {},
      onError(message) {
        receiverErrors.push(message);
        completion.reject(new Error(message));
      },
      onFileReceived() {},
      onMode() {},
      onProgress() {},
      onStatus() {},
    },
    receivedFiles,
  );

  try {
    await completion.promise;
    expect(receiverErrors).toEqual([]);
    expect(senderProgress[0]).toMatchObject({
      completedBytes: 5,
      completedFiles: 1,
      fileId: "file-2",
    });
  } finally {
    sender.stop();
    receiver.stop();
  }
});
