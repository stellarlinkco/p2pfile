import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { RelayMessageQueue } from "./relay-queue";
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
      if (typeof data !== "string") return;
      const message = JSON.parse(data) as TransferProtocolMessage & { bytesBase64?: string };
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
    this.queue = new RelayMessageQueue((envelope: BrowserSignalMessage) => {
      if (envelope.type !== "relay-message") return;
      this.queue.acknowledge(envelope.payload.sequence);
      const message = envelope.payload.message;
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
      .map((message) => (message.type === "chunk" ? message.fileId : "")),
  ).toEqual(["file-1", "file-2"]);

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

  await harness.waitForChunk("file-3", 0);
  harness.commit("file-3", 0);
  await harness.file3End.promise;
  harness.commit("file-1", 0);
  await harness.waitForChunk("file-1", 1);
  harness.commit("file-1", 1);
  await harness.waitForChunk("file-1", 2);
  harness.commit("file-1", 2);
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
      .map((message) => (message.type === "chunk" ? message.fileId : "")),
  ).toEqual(["file-1", "file-2"]);

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

  await harness.waitForChunk("file-3", 0);
  harness.commit("file-3", 0);
  await harness.file3End.promise;
  harness.commit("file-1", 0);
  await harness.waitForChunk("file-1", 1);
  harness.commit("file-1", 1);
  await harness.waitForChunk("file-1", 2);
  harness.commit("file-1", 2);
  await transfer;
}

test("direct scheduler bounds active files and in-flight bytes while small files finish first", async () => {
  const files = schedulerFiles();
  const plan = buildTransferPlan(files);
  const harness = new DirectHarness();
  const transfer = sendFiles(harness.channel, files, plan, noopHandlers, 0, () => true, undefined, {
    maxActiveFiles: 2,
    maxInFlightBytes: MANIFEST_CHUNK_BYTES * 2,
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
      maxInFlightBytes: MANIFEST_CHUNK_BYTES * 2,
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
