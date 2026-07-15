import { expect, test } from "bun:test";
import { buildReceiverState, handleProtocolMessage } from "./runtime-shared";
import type { ReceiverRuntimeHandlers, TransferProgress } from "./types";

function receiverHandlersWith(
  overrides: Partial<ReceiverRuntimeHandlers>,
): ReceiverRuntimeHandlers {
  return {
    onStatus() {},
    onMode() {},
    onProgress() {},
    onComplete() {},
    onError() {},
    onFileReceived() {},
    onEnded() {},
    ...overrides,
  };
}

function bytesOf(content: string) {
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}

async function sha256Buffer(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("duplicate committed chunk re-acks without rewriting or double-counting progress", async () => {
  const manifestItem = {
    id: "file-1",
    name: "alpha.txt",
    size: 10,
    mimeType: "text/plain",
  };
  const state = buildReceiverState([manifestItem]);
  const progressEvents: TransferProgress[] = [];
  const handlers = receiverHandlersWith({
    onProgress(progress) {
      progressEvents.push(progress);
    },
  });
  const firstChunk = bytesOf("alpha");
  const tailChunk = bytesOf("omega");
  const firstChunkDigest = await sha256Buffer(firstChunk);
  const committedBytes: number[] = [];

  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    handlers,
  );
  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 0,
      offset: 0,
      bytes: firstChunk,
      chunkDigest: firstChunkDigest,
    },
    state,
    handlers,
    {
      onChunkCommit(ack) {
        committedBytes.push(ack.committedBytes);
      },
    },
  );
  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    handlers,
  );

  const context = state.fileStates.get("file-1");
  const sink = context?.sink;
  expect(context?.bytes).toBe(5);
  expect(progressEvents).toHaveLength(1);
  expect(progressEvents[0]?.completedBytes).toBe(5);
  if (!sink) throw new Error("Expected receiver sink after first committed chunk.");

  let duplicateWriteCalls = 0;
  const originalWrite = sink.write.bind(sink);
  sink.write = async (offset, bytes, file) => {
    duplicateWriteCalls += 1;
    await originalWrite(offset, bytes, file);
  };

  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 0,
      offset: 0,
      bytes: firstChunk,
      chunkDigest: firstChunkDigest,
    },
    state,
    handlers,
    {
      onChunkCommit(ack) {
        committedBytes.push(ack.committedBytes);
      },
    },
  );

  expect(duplicateWriteCalls).toBe(0);
  expect(committedBytes).toEqual([5, 5]);
  expect(state.failed).toBe(false);
  expect(context.bytes).toBe(5);
  expect(state.currentBytes).toBe(5);
  expect(state.committedBytesByFileId.get("file-1")).toBe(5);
  expect(progressEvents).toHaveLength(1);
  expect(progressEvents[0]?.completedBytes).toBe(5);

  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 1,
      offset: 5,
      bytes: tailChunk,
      chunkDigest: await sha256Buffer(tailChunk),
    },
    state,
    handlers,
  );
  await handleProtocolMessage(
    {
      type: "file-end",
      fileId: "file-1",
      bytes: 10,
      digest: await sha256Buffer(await new Blob([firstChunk, tailChunk]).arrayBuffer()),
    },
    state,
    handlers,
  );

  expect(state.failed).toBe(false);
  expect(context.state).toBe("completed");
});

test("whole-file integrity failure invalidates resumable progress", async () => {
  const file = { id: "file-1", name: "alpha.txt", size: 5 };
  const bytes = bytesOf("alpha");
  const invalidated: string[] = [];
  const state = buildReceiverState([file]);
  const handlers = receiverHandlersWith({
    onFileIntegrityFailure(fileId) {
      invalidated.push(fileId);
    },
  });
  await handleProtocolMessage({ type: "file-start", file, offset: 0 }, state, handlers);
  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: file.id,
      chunkIndex: 0,
      offset: 0,
      bytes,
      chunkDigest: await sha256Buffer(bytes),
    },
    state,
    handlers,
  );

  await expect(
    handleProtocolMessage(
      { type: "file-end", fileId: file.id, bytes: file.size, digest: "invalid-digest" },
      state,
      handlers,
    ),
  ).rejects.toThrow("File integrity verification failed.");
  expect(invalidated).toEqual([file.id]);
  expect(state.committedBytesByFileId.get(file.id)).toBe(0);
});
