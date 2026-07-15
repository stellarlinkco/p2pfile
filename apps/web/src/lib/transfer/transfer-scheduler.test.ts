import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { RelayMessageQueue } from "./relay-queue";
import { decodeBinaryChunk, decodeBinaryRelayChunkFrame, toRelayMessage } from "./relay-runtime";
import { buildTransferPlan, sendFiles, sendFilesViaRelay } from "./sender-runtime-helpers";
import type {
  BrowserSignalMessage,
  RelayProtocolMessage,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

const noopHandlers: SenderRuntimeHandlers = {
  onStatus() {},
  onMode() {},
  onProgress() {},
  onComplete() {},
  onError() {},
};

function fixedFlow(chunks: number) {
  return {
    currentMaxInFlightBytes: () => chunks * MANIFEST_CHUNK_BYTES,
  };
}

function makeBytes(size: number, seed: number) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index + seed) % 251;
  }
  return bytes;
}

function schedulerFiles() {
  return [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 3, 1)], "large-first.zip", {
      type: "application/zip",
    }),
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 2)], "small-middle.txt", { type: "text/plain" }),
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 3)], "small-late.bin", {
      type: "application/octet-stream",
    }),
  ];
}

function flushMicrotasks() {
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined);
}

async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 5;
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(intervalMs);
  }
}

function chunkKey(fileId: string, chunkIndex: number) {
  return `${fileId}:${chunkIndex}`;
}

class DirectHarness {
  readonly messages: Array<TransferProtocolMessage & { bytesBase64?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  private readonly chunkGates = new Map<string, PromiseWithResolvers<void>>();
  private readonly sentChunks = new Map<
    string,
    TransferProtocolMessage & { type: "chunk"; bytesBase64?: string }
  >();
  readonly firstWindow = Promise.withResolvers<void>();
  readonly file2End = Promise.withResolvers<void>();
  readonly file3Start = Promise.withResolvers<void>();
  readonly file3End = Promise.withResolvers<void>();
  private chunkCount = 0;

  readonly channel = {
    bufferedAmount: 0,
    readyState: "open",
    send: (data: unknown) => {
      let message: (TransferProtocolMessage & { bytesBase64?: string }) | null = null;
      if (typeof data === "string") {
        message = JSON.parse(data) as TransferProtocolMessage & { bytesBase64?: string };
      } else if (data instanceof ArrayBuffer) {
        message = decodeBinaryChunk(data);
      }
      if (!message) return;
      this.messages.push(message);
      if (message.type === "file-start" && message.file.id === "file-3") {
        this.file3Start.resolve();
      }
      if (message.type === "file-end" && message.fileId === "file-2") {
        this.file2End.resolve();
      }
      if (message.type === "file-end" && message.fileId === "file-3") {
        this.file3End.resolve();
      }
      if (message.type === "chunk") {
        this.chunkCount += 1;
        this.sentChunks.set(
          chunkKey(message.fileId, message.chunkIndex),
          message as TransferProtocolMessage & { type: "chunk"; bytesBase64?: string },
        );
        this.chunkGates.get(chunkKey(message.fileId, message.chunkIndex))?.resolve();
        if (this.chunkCount === 2) this.firstWindow.resolve();
      }
    },
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      this.listeners.get(type)?.delete(listener);
    },
  } as unknown as RTCDataChannel;

  waitForChunk(fileId: string, chunkIndex: number) {
    const key = chunkKey(fileId, chunkIndex);
    if (this.sentChunks.has(key)) return Promise.resolve();
    const gate = this.chunkGates.get(key) ?? Promise.withResolvers<void>();
    this.chunkGates.set(key, gate);
    return gate.promise;
  }

  commit(fileId: string, chunkIndex: number) {
    const chunk = this.sentChunks.get(chunkKey(fileId, chunkIndex));
    if (!chunk) throw new Error(`missing chunk ${fileId}:${chunkIndex}`);
    const committedBytes =
      chunk.offset + (chunk.bytesBase64 ? atob(chunk.bytesBase64).length : chunk.bytes.byteLength);
    for (const listener of this.listeners.get("message") ?? []) {
      listener(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "chunk-commit",
            fileId,
            chunkIndex,
            committedBytes,
          } satisfies TransferProtocolMessage),
        }),
      );
    }
  }
}

class RelayHarness {
  readonly messages: RelayProtocolMessage[] = [];
  private readonly chunkGates = new Map<string, PromiseWithResolvers<void>>();
  private readonly sentChunks = new Map<string, Extract<RelayProtocolMessage, { type: "chunk" }>>();
  readonly firstWindow = Promise.withResolvers<void>();
  readonly file2End = Promise.withResolvers<void>();
  readonly file3Start = Promise.withResolvers<void>();
  readonly file3End = Promise.withResolvers<void>();
  private chunkCount = 0;
  readonly queue: RelayMessageQueue;

  constructor() {
    this.queue = new RelayMessageQueue((data: string | ArrayBuffer) => {
      let message: RelayProtocolMessage | null = null;
      let sequence = -1;
      if (typeof data === "string") {
        const envelope = JSON.parse(data) as BrowserSignalMessage;
        if (envelope.type !== "relay-message") return;
        message = envelope.payload.message;
        sequence = envelope.payload.sequence;
      } else {
        const decoded = decodeBinaryRelayChunkFrame(data);
        if (!decoded) return;
        message = toRelayMessage(decoded.message);
        sequence = decoded.sequence;
      }
      this.queue.acknowledge(sequence);
      this.messages.push(message);
      if (message.type === "file-start" && message.file.id === "file-3") {
        this.file3Start.resolve();
      }
      if (message.type === "file-end" && message.fileId === "file-2") {
        this.file2End.resolve();
      }
      if (message.type === "file-end" && message.fileId === "file-3") {
        this.file3End.resolve();
      }
      if (message.type === "chunk") {
        this.chunkCount += 1;
        this.sentChunks.set(chunkKey(message.fileId, message.chunkIndex), message);
        this.chunkGates.get(chunkKey(message.fileId, message.chunkIndex))?.resolve();
        if (this.chunkCount === 2) this.firstWindow.resolve();
      }
    });
  }

  waitForChunk(fileId: string, chunkIndex: number) {
    const key = chunkKey(fileId, chunkIndex);
    if (this.sentChunks.has(key)) return Promise.resolve();
    const gate = this.chunkGates.get(key) ?? Promise.withResolvers<void>();
    this.chunkGates.set(key, gate);
    return gate.promise;
  }

  commit(fileId: string, chunkIndex: number) {
    const chunk = this.sentChunks.get(chunkKey(fileId, chunkIndex));
    if (!chunk) throw new Error(`missing chunk ${fileId}:${chunkIndex}`);
    this.queue.commit({
      type: "chunk-commit",
      fileId,
      chunkIndex,
      committedBytes: chunk.offset + atob(chunk.bytesBase64).length,
    });
  }
}

async function finishControlledDirectTransfer(harness: DirectHarness, transfer: Promise<void>) {
  await harness.firstWindow.promise;
  await flushMicrotasks();
  expect(
    harness.messages
      .filter((message) => message.type === "file-start")
      .map((message) => (message.type === "file-start" ? message.file.id : "")),
  ).toEqual(["file-1", "file-2"]);
  expect(
    harness.messages
      .filter((message) => message.type === "chunk")
      .map((message) =>
        message.type === "chunk" ? `${message.fileId}:${message.chunkIndex}` : "",
      ),
  ).toEqual(["file-1:0", "file-2:0"]);

  harness.commit("file-2", 0);
  await harness.file2End.promise;
  await harness.file3Start.promise;
  expect(
    harness.messages.findIndex(
      (message) => message.type === "file-end" && message.fileId === "file-2",
    ),
  ).toBeLessThan(
    harness.messages.findIndex(
      (message) => message.type === "file-start" && message.file.id === "file-3",
    ),
  );
  expect(
    harness.messages.find((message) => message.type === "file-end" && message.fileId === "file-1"),
  ).toBeUndefined();

  // Free one window slot so the newly activated small file can send.
  harness.commit("file-1", 0);
  await harness.waitForChunk("file-3", 0);
  harness.commit("file-3", 0);
  await harness.file3End.promise;

  // Drain the large file's remaining pipelined chunks in commit order.
  for (const chunkIndex of [1, 2]) {
    await harness.waitForChunk("file-1", chunkIndex);
    harness.commit("file-1", chunkIndex);
  }
  await transfer;
}

async function finishControlledRelayTransfer(harness: RelayHarness, transfer: Promise<void>) {
  await harness.firstWindow.promise;
  await flushMicrotasks();
  expect(
    harness.messages
      .filter((message) => message.type === "file-start")
      .map((message) => (message.type === "file-start" ? message.file.id : "")),
  ).toEqual(["file-1", "file-2"]);
  expect(
    harness.messages
      .filter((message) => message.type === "chunk")
      .map((message) =>
        message.type === "chunk" ? `${message.fileId}:${message.chunkIndex}` : "",
      ),
  ).toEqual(["file-1:0", "file-2:0"]);

  harness.commit("file-2", 0);
  await harness.file2End.promise;
  await harness.file3Start.promise;
  expect(
    harness.messages.findIndex(
      (message) => message.type === "file-end" && message.fileId === "file-2",
    ),
  ).toBeLessThan(
    harness.messages.findIndex(
      (message) => message.type === "file-start" && message.file.id === "file-3",
    ),
  );
  expect(
    harness.messages.find((message) => message.type === "file-end" && message.fileId === "file-1"),
  ).toBeUndefined();

  harness.commit("file-1", 0);
  await harness.waitForChunk("file-3", 0);
  harness.commit("file-3", 0);
  await harness.file3End.promise;

  for (const chunkIndex of [1, 2]) {
    await harness.waitForChunk("file-1", chunkIndex);
    harness.commit("file-1", chunkIndex);
  }
  await transfer;
}

test("direct scheduler bounds active files and in-flight bytes while small files finish first", async () => {
  const files = schedulerFiles();
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();
  const transfer = sendFiles(harness.channel, files, plan, noopHandlers, 0, () => true, undefined, {
    maxActiveFiles: 2,
    flowControl: fixedFlow(2),
  });

  await finishControlledDirectTransfer(harness, transfer);

  const completedOrder = harness.messages
    .filter((message) => message.type === "file-end")
    .map((message) => (message.type === "file-end" ? message.fileId : ""));
  expect(completedOrder).toEqual(["file-2", "file-3", "file-1"]);
});

test("relay scheduler follows the same active-file and in-flight byte bounds", async () => {
  const files = schedulerFiles();
  const plan = buildTransferPlan(files);
  const harness = new RelayHarness();
  const transfer = sendFilesViaRelay(
    harness.queue,
    files,
    plan,
    noopHandlers,
    0,
    () => true,
    undefined,
    {
      maxActiveFiles: 2,
      flowControl: fixedFlow(2),
    },
  );

  try {
    await finishControlledRelayTransfer(harness, transfer);
  } finally {
    harness.queue.stop();
  }

  const completedOrder = harness.messages
    .filter((message) => message.type === "file-end")
    .map((message) => (message.type === "file-end" ? message.fileId : ""));
  expect(completedOrder).toEqual(["file-2", "file-3", "file-1"]);
});

test("single file pipelines multiple chunks within the in-flight byte window", async () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 4, 9)], "pipeline.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();
  const progressSnapshots: number[] = [];
  const handlers: SenderRuntimeHandlers = {
    ...noopHandlers,
    onProgress(progress) {
      progressSnapshots.push(progress.completedBytes);
    },
  };

  const transfer = sendFiles(harness.channel, files, plan, handlers, 0, () => true, undefined, {
    maxActiveFiles: 1,
    flowControl: fixedFlow(4),
  });

  await harness.waitForChunk("file-1", 0);
  await harness.waitForChunk("file-1", 1);
  await harness.waitForChunk("file-1", 2);
  await harness.waitForChunk("file-1", 3);
  await flushMicrotasks();

  const inFlightChunkIndexes = harness.messages
    .filter((message) => message.type === "chunk")
    .map((message) => (message.type === "chunk" ? message.chunkIndex : -1));
  expect(inFlightChunkIndexes).toEqual([0, 1, 2, 3]);
  // No commits yet — durable progress must still be zero while chunks are only in flight.
  expect(Math.max(0, ...progressSnapshots)).toBe(0);

  for (const chunkIndex of [0, 1, 2, 3]) {
    harness.commit("file-1", chunkIndex);
  }
  await transfer;

  expect(
    harness.messages.some((message) => message.type === "file-end" && message.fileId === "file-1"),
  ).toBe(true);
});

test("durable progress advances only after ordered commits", async () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 3, 13)], "ordered.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();
  const progressSnapshots: number[] = [];
  const handlers: SenderRuntimeHandlers = {
    ...noopHandlers,
    onProgress(progress) {
      progressSnapshots.push(progress.completedBytes);
    },
  };

  const transfer = sendFiles(harness.channel, files, plan, handlers, 0, () => true, undefined, {
    maxActiveFiles: 1,
    flowControl: fixedFlow(3),
  });

  await harness.waitForChunk("file-1", 0);
  await harness.waitForChunk("file-1", 1);
  await harness.waitForChunk("file-1", 2);
  expect(Math.max(0, ...progressSnapshots)).toBe(0);

  harness.commit("file-1", 0);
  await waitFor(() => progressSnapshots.at(-1) === MANIFEST_CHUNK_BYTES);

  harness.commit("file-1", 1);
  await waitFor(() => progressSnapshots.at(-1) === MANIFEST_CHUNK_BYTES * 2);

  harness.commit("file-1", 2);
  await transfer;
  expect(progressSnapshots.at(-1)).toBe(MANIFEST_CHUNK_BYTES * 3);
});
test("global in-flight byte window still caps pipelined sends", async () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 6, 17)], "window.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();

  const transfer = sendFiles(harness.channel, files, plan, noopHandlers, 0, () => true, undefined, {
    maxActiveFiles: 1,
    flowControl: fixedFlow(2),
  });

  await harness.waitForChunk("file-1", 0);
  await harness.waitForChunk("file-1", 1);
  await flushMicrotasks();

  const inFlightBeforeCommit = harness.messages.filter((message) => message.type === "chunk");
  expect(inFlightBeforeCommit).toHaveLength(2);
  expect(
    harness.messages.some((message) => message.type === "chunk" && message.chunkIndex === 2),
  ).toBe(false);

  harness.commit("file-1", 0);
  await harness.waitForChunk("file-1", 2);
  await flushMicrotasks();
  expect(
    harness.messages
      .filter((message) => message.type === "chunk")
      .map((message) => (message.type === "chunk" ? message.chunkIndex : -1)),
  ).toEqual([0, 1, 2]);

  for (const chunkIndex of [1, 2, 3, 4, 5]) {
    await harness.waitForChunk("file-1", chunkIndex);
    harness.commit("file-1", chunkIndex);
  }
  await transfer;
});

test("scheduler applies a changed flow window at the next scheduling boundary", async () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 6, 23)], "dynamic-window.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();
  let chunks = 2;
  const transfer = sendFiles(harness.channel, files, plan, noopHandlers, 0, () => true, undefined, {
    maxActiveFiles: 1,
    flowControl: {
      currentMaxInFlightBytes: () => chunks * MANIFEST_CHUNK_BYTES,
    },
  });

  await harness.waitForChunk("file-1", 1);
  chunks = 3;
  harness.commit("file-1", 0);
  await harness.waitForChunk("file-1", 3);
  await flushMicrotasks();
  expect(
    harness.messages
      .filter((message) => message.type === "chunk")
      .map((message) => (message.type === "chunk" ? message.chunkIndex : -1)),
  ).toEqual([0, 1, 2, 3]);
  expect(
    harness.messages.some((message) => message.type === "chunk" && message.chunkIndex === 4),
  ).toBe(false);

  for (const chunkIndex of [1, 2, 3, 4, 5]) {
    harness.commit("file-1", chunkIndex);
    if (chunkIndex < 5) await harness.waitForChunk("file-1", chunkIndex + 1);
  }
  await transfer;
});

test("default scheduler window pipelines more than one chunk on a single file", async () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 8, 19)], "default-window.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();

  const transfer = sendFiles(harness.channel, files, plan, noopHandlers, 0, () => true);

  // Default window is 16 chunks; an 8-chunk file should fully pipeline before any commit.
  for (let chunkIndex = 0; chunkIndex < 8; chunkIndex += 1) {
    await harness.waitForChunk("file-1", chunkIndex);
  }
  await flushMicrotasks();
  expect(harness.messages.filter((message) => message.type === "chunk")).toHaveLength(8);

  for (let chunkIndex = 0; chunkIndex < 8; chunkIndex += 1) {
    harness.commit("file-1", chunkIndex);
  }
  await transfer;
});

test("pipelined commits may resolve out of order without failing the transfer", async () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 3, 29)], "ooo.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();
  const errors: string[] = [];
  const handlers: SenderRuntimeHandlers = {
    ...noopHandlers,
    onError(message) {
      errors.push(message);
    },
  };

  const transfer = sendFiles(harness.channel, files, plan, handlers, 0, () => true, undefined, {
    maxActiveFiles: 1,
    flowControl: fixedFlow(3),
  });

  await harness.waitForChunk("file-1", 0);
  await harness.waitForChunk("file-1", 1);
  await harness.waitForChunk("file-1", 2);

  // Resolve later commits first to surface any naive sequential-offset race.
  harness.commit("file-1", 2);
  harness.commit("file-1", 1);
  harness.commit("file-1", 0);
  await transfer;

  expect(errors).toEqual([]);
  expect(
    harness.messages.some((message) => message.type === "file-end" && message.fileId === "file-1"),
  ).toBe(true);
});

test("auto-acked single-file pipeline completes with file-end and complete", async () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 32, 41)], "auto-complete.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const messages: Array<TransferProtocolMessage & { bytesBase64?: string }> = [];

  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send(data: unknown) {
      let message: (TransferProtocolMessage & { bytesBase64?: string }) | null = null;
      if (typeof data === "string") {
        message = JSON.parse(data) as TransferProtocolMessage & { bytesBase64?: string };
      } else if (data instanceof ArrayBuffer) {
        message = decodeBinaryChunk(data);
      }
      if (!message) return;
      messages.push(message);
      if (message.type !== "chunk") return;
      const committedBytes =
        message.offset +
        (message.bytesBase64 ? atob(message.bytesBase64).length : message.bytes.byteLength);
      queueMicrotask(() => {
        for (const listener of listeners.get("message") ?? []) {
          listener(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "chunk-commit",
                fileId: message.fileId,
                chunkIndex: message.chunkIndex,
                committedBytes,
              } satisfies TransferProtocolMessage),
            }),
          );
        }
      });
    },
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const set = listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as RTCDataChannel;

  await sendFiles(channel, files, plan, noopHandlers, 0, () => true);

  expect(messages.some((message) => message.type === "file-end")).toBe(true);
  expect(messages.some((message) => message.type === "complete")).toBe(true);
  expect(messages.filter((message) => message.type === "chunk")).toHaveLength(32);
});
