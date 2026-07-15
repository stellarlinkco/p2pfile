import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES, type ResumeProgress } from "@p2pfile/shared";
import { RelayMessageQueue } from "./relay-queue";
import { decodeBinaryChunk, decodeBinaryRelayChunkFrame, toRelayMessage } from "./relay-runtime";
import {
  buildTransferPlan,
  mergeResumeProgress,
  normalizeResumeProgress,
  sendFiles,
  sendFilesViaRelay,
} from "./sender-runtime-helpers";
import type {
  BrowserSignalMessage,
  RelayProtocolMessage,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

function parseChannelMessage(data: unknown): TransferProtocolMessage | null {
  if (typeof data === "string") return JSON.parse(data) as TransferProtocolMessage;
  if (data instanceof ArrayBuffer) return decodeBinaryChunk(data);
  return null;
}

function handleRelayWire(
  data: string | ArrayBuffer,
  onMessage: (message: RelayProtocolMessage, sequence: number) => void,
) {
  if (typeof data === "string") {
    const envelope = JSON.parse(data) as BrowserSignalMessage;
    if (envelope.type !== "relay-message") return;
    onMessage(envelope.payload.message, envelope.payload.sequence);
    return;
  }
  const decoded = decodeBinaryRelayChunkFrame(data);
  if (!decoded) return;
  onMessage(toRelayMessage(decoded.message), decoded.sequence);
}

const noopHandlers: SenderRuntimeHandlers = {
  onStatus() {},
  onMode() {},
  onProgress() {},
  onComplete() {},
  onError() {},
};

async function sha256Hex(content: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeBytes(size: number, seed: number) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + seed) % 251;
  }
  return bytes;
}

function commitRelayChunk(queue: RelayMessageQueue, message: RelayProtocolMessage) {
  if (message.type !== "chunk") return;
  queue.commit({
    type: "chunk-commit",
    fileId: message.fileId,
    chunkIndex: message.chunkIndex,
    committedBytes: message.offset + atob(message.bytesBase64).length,
  });
}

function fileAt(files: File[], index: number) {
  const file = files[index];
  if (!file) throw new Error(`Missing test file at index ${index}.`);
  return file;
}
const GIB = 1024 ** 3;

function makeVirtualFile(name: string, size: number, type = "application/octet-stream") {
  return {
    name,
    size,
    type,
    slice(start = 0, end = size) {
      const chunkBytes = Math.max(0, Math.min(size, end) - Math.min(size, start));
      return new Blob([new Uint8Array(chunkBytes)], { type });
    },
  } as unknown as File;
}

test("transfer plan reuses frozen manifest ids", () => {
  const file = new File(["alpha"], "alpha.txt", { type: "text/plain" });
  const plan = buildTransferPlan(
    [file],
    [{ id: "local-1", name: "alpha.txt", size: file.size, mimeType: "text/plain" }],
  );

  expect(plan.manifest).toEqual([{ id: "local-1", name: "alpha.txt", size: file.size }]);
});

test("sender rejects ResumeProgress that marks an incomplete manifest item completed", () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 2, 21)], "large-a.zip", {
      type: "application/zip",
    }),
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 22)], "large-b.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);

  expect(() =>
    normalizeResumeProgress(plan, {
      manifestHash: plan.manifestHash,
      files: [
        {
          fileId: "file-1",
          size: fileAt(files, 0).size,
          chunkSize: MANIFEST_CHUNK_BYTES,
          committedBytes: MANIFEST_CHUNK_BYTES,
          completed: true,
        },
        {
          fileId: "file-2",
          size: fileAt(files, 1).size,
          chunkSize: MANIFEST_CHUNK_BYTES,
          committedBytes: 0,
          completed: false,
        },
      ],
    }),
  ).toThrow("Receiver ResumeProgress completed flag does not match committed bytes.");
});

test("sender keeps newer active ResumeProgress when a stale receiver-ready arrives", () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 21)], "done.bin"),
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 4, 22)], "active.zip", {
      type: "application/zip",
    }),
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 23)], "queued.bin"),
  ];
  const plan = buildTransferPlan(files);
  const current: ResumeProgress = {
    manifestHash: plan.manifestHash,
    files: [
      {
        fileId: "file-1",
        size: fileAt(files, 0).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: fileAt(files, 0).size,
        completed: true,
      },
      {
        fileId: "file-2",
        size: fileAt(files, 1).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: MANIFEST_CHUNK_BYTES * 2,
        completed: false,
      },
      {
        fileId: "file-3",
        size: fileAt(files, 2).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: 0,
        completed: false,
      },
    ],
  };
  const stale: ResumeProgress = {
    manifestHash: plan.manifestHash,
    files: [
      {
        fileId: "file-1",
        size: fileAt(files, 0).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: fileAt(files, 0).size,
        completed: true,
      },
      {
        fileId: "file-2",
        size: fileAt(files, 1).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: 0,
        completed: false,
      },
      {
        fileId: "file-3",
        size: fileAt(files, 2).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: 0,
        completed: false,
      },
    ],
  };

  expect(mergeResumeProgress(plan, current, stale)).toEqual(current);
});
test("sender trusts authoritative receiver restart progress that resets an active offset", () => {
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 4, 31)], "active-reset.zip", {
      type: "application/zip",
    }),
  ];
  const plan = buildTransferPlan(files);
  const current: ResumeProgress = {
    manifestHash: plan.manifestHash,
    files: [
      {
        fileId: "file-1",
        size: fileAt(files, 0).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: MANIFEST_CHUNK_BYTES * 2,
        completed: false,
      },
    ],
  };
  const reset: ResumeProgress = {
    manifestHash: plan.manifestHash,
    files: [
      {
        fileId: "file-1",
        size: fileAt(files, 0).size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes: 0,
        completed: false,
      },
    ],
  };

  expect(mergeResumeProgress(plan, current, reset, { authoritativeReset: true })).toEqual(reset);
});

test("direct resume emits full-manifest resume events for completed active and queued files", async () => {
  const eventsTarget = globalThis as {
    __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
  };
  eventsTarget.__P2PFILE_TEST_TRANSFER_EVENTS__ = [];
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send(data: unknown) {
      const message = parseChannelMessage(data);
      if (message?.type !== "chunk") return;
      for (const listener of listeners.get("message") ?? []) {
        listener(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "chunk-commit",
              fileId: message.fileId,
              chunkIndex: message.chunkIndex,
              committedBytes: message.offset + message.bytes.byteLength,
            } satisfies TransferProtocolMessage),
          }),
        );
      }
    },
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const nextListeners = listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
      nextListeners.add(listener);
      listeners.set(type, nextListeners);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as RTCDataChannel;
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 23)], "completed.bin"),
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 2, 24)], "active.zip", {
      type: "application/zip",
    }),
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 25)], "queued.bin"),
  ];
  const plan = buildTransferPlan(files);

  try {
    await sendFiles(
      channel,
      files,
      plan,
      noopHandlers,
      {
        manifestHash: plan.manifestHash,
        files: [
          {
            fileId: "file-1",
            size: fileAt(files, 0).size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: fileAt(files, 0).size,
            completed: true,
          },
          {
            fileId: "file-2",
            size: fileAt(files, 1).size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: MANIFEST_CHUNK_BYTES,
            completed: false,
          },
          {
            fileId: "file-3",
            size: fileAt(files, 2).size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: 0,
            completed: false,
          },
        ],
      },
      () => true,
    );
  } finally {
    const events = eventsTarget.__P2PFILE_TEST_TRANSFER_EVENTS__ ?? [];
    delete eventsTarget.__P2PFILE_TEST_TRANSFER_EVENTS__;
    expect(
      events
        .filter((event) => event.type === "direct-file-start")
        .map((event) => ({ fileId: event.fileId, offset: event.offset })),
    ).toEqual([
      { fileId: "file-2", offset: MANIFEST_CHUNK_BYTES },
      { fileId: "file-3", offset: 0 },
    ]);
    expect(
      events
        .filter((event) => event.type === "direct-chunk-commit")
        .map((event) => ({ fileId: event.fileId, chunkIndex: event.chunkIndex })),
    ).toEqual([
      { fileId: "file-2", chunkIndex: 1 },
      { fileId: "file-3", chunkIndex: 0 },
    ]);
  }
});

test("relay resume sends only active committed tail and queued files from full manifest", async () => {
  const relayMessages: RelayProtocolMessage[] = [];
  const queue = new RelayMessageQueue((data) => {
    handleRelayWire(data, (message, sequence) => {
      relayMessages.push(message);
      queue.acknowledge(sequence);
      commitRelayChunk(queue, message);
    });
  });
  const files = [
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 26)], "completed.bin"),
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 2, 27)], "active.zip", {
      type: "application/zip",
    }),
    new File([makeBytes(MANIFEST_CHUNK_BYTES, 28)], "queued.bin"),
  ];
  const plan = buildTransferPlan(files);

  try {
    await sendFilesViaRelay(
      queue,
      files,
      plan,
      noopHandlers,
      {
        manifestHash: plan.manifestHash,
        files: [
          {
            fileId: "file-1",
            size: fileAt(files, 0).size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: fileAt(files, 0).size,
            completed: true,
          },
          {
            fileId: "file-2",
            size: fileAt(files, 1).size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: MANIFEST_CHUNK_BYTES,
            completed: false,
          },
          {
            fileId: "file-3",
            size: fileAt(files, 2).size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: 0,
            completed: false,
          },
        ],
      },
      () => true,
    );
  } finally {
    queue.stop();
  }

  expect(
    relayMessages
      .filter((message) => message.type === "file-start")
      .map((message) => ({ fileId: message.file.id, offset: message.offset })),
  ).toEqual([
    { fileId: "file-2", offset: MANIFEST_CHUNK_BYTES },
    { fileId: "file-3", offset: 0 },
  ]);
  expect(
    relayMessages
      .filter((message) => message.type === "chunk")
      .map((message) => ({ fileId: message.fileId, chunkIndex: message.chunkIndex })),
  ).toEqual([
    { fileId: "file-2", chunkIndex: 1 },
    { fileId: "file-3", chunkIndex: 0 },
  ]);
});

test("direct file-end carries the sha-256 digest of the file content", async () => {
  const sent: unknown[] = [];
  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send(data: unknown) {
      sent.push(data);
    },
  } as unknown as RTCDataChannel;
  const file = new File(["alpha"], "alpha.txt", { type: "text/plain" });
  const plan = buildTransferPlan([file]);

  await sendFiles(channel, [file], plan, noopHandlers, 0, () => true);

  const fileEnd = sent
    .map((data) => parseChannelMessage(data))
    .find((message) => message?.type === "file-end");
  expect(fileEnd).toMatchObject({
    fileId: "file-1",
    bytes: file.size,
    digest: await sha256Hex("alpha"),
  });
});

test("direct transfer normalizes closed data channel send failures", async () => {
  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send() {
      throw new DOMException(
        "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
        "InvalidStateError",
      );
    },
  } as unknown as RTCDataChannel;
  const file = new File(["alpha"], "alpha.txt", { type: "text/plain" });
  const plan = buildTransferPlan([file]);

  await expect(sendFiles(channel, [file], plan, noopHandlers, 0, () => true)).rejects.toThrow(
    "Data channel is not open.",
  );
});

test("direct transfer handles giant zip sizes without allocating the whole file", async () => {
  for (const size of [GIB, 10 * GIB, 100 * GIB, 1000 * GIB]) {
    const sent: unknown[] = [];
    let binarySends = 0;
    const channel = {
      bufferedAmount: 0,
      readyState: "open",
      send(data: unknown) {
        if (data instanceof ArrayBuffer) {
          binarySends += 1;
          throw new DOMException(
            "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
            "InvalidStateError",
          );
        }
        sent.push(data);
      },
    } as unknown as RTCDataChannel;
    const file = makeVirtualFile(`archive-${size / GIB}g.zip`, size, "application/zip");
    const plan = buildTransferPlan([file]);

    await expect(sendFiles(channel, [file], plan, noopHandlers, 0, () => true)).rejects.toThrow(
      "Data channel is not open.",
    );

    const manifest = sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data) as TransferProtocolMessage)
      .find((message) => message.type === "manifest");
    expect(manifest).toEqual({
      type: "manifest",
      files: [{ id: "file-1", name: file.name, size }],
      totalBytes: size,
      manifestHash: plan.manifestHash,
    });
    expect(binarySends).toBe(1);
  }
});

test("direct resume treats a leading completed zero-byte file as already sent before an active offset", async () => {
  const sent: unknown[] = [];
  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send(data: unknown) {
      sent.push(data);
    },
  } as unknown as RTCDataChannel;
  const files = [
    new File([], "empty.txt"),
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 2, 7)], "large.zip", { type: "application/zip" }),
  ];
  const plan = buildTransferPlan(files);

  await sendFiles(
    channel,
    files,
    plan,
    noopHandlers,
    {
      manifestHash: plan.manifestHash,
      files: [
        {
          fileId: "file-1",
          size: 0,
          chunkSize: MANIFEST_CHUNK_BYTES,
          committedBytes: 0,
          completed: true,
        },
        {
          fileId: "file-2",
          size: fileAt(files, 1).size,
          chunkSize: MANIFEST_CHUNK_BYTES,
          committedBytes: MANIFEST_CHUNK_BYTES,
          completed: false,
        },
      ],
    },
    () => true,
  );

  const protocolMessages = sent
    .map((data) => parseChannelMessage(data))
    .filter((message): message is TransferProtocolMessage => message !== null);
  expect(
    protocolMessages
      .filter((message) => message.type === "file-start" || message.type === "file-end")
      .map((message) =>
        message.type === "file-start"
          ? { type: message.type, fileId: message.file.id, offset: message.offset }
          : { type: message.type, fileId: message.fileId, bytes: message.bytes },
      ),
  ).toEqual([
    { type: "file-start", fileId: "file-2", offset: MANIFEST_CHUNK_BYTES },
    { type: "file-end", fileId: "file-2", bytes: fileAt(files, 1).size },
  ]);
});

test("direct transfer advances resumable sender cursor after committed chunks before channel failure", async () => {
  const sent: unknown[] = [];
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  let chunkSends = 0;
  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send(data: unknown) {
      const message = parseChannelMessage(data);
      if (message?.type === "chunk") {
        chunkSends += 1;
        if (chunkSends === 2) {
          throw new DOMException(
            "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
            "InvalidStateError",
          );
        }
        for (const listener of listeners.get("message") ?? []) {
          listener(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "chunk-commit",
                fileId: message.fileId,
                chunkIndex: message.chunkIndex,
                committedBytes: message.offset + MANIFEST_CHUNK_BYTES,
              } satisfies TransferProtocolMessage),
            }),
          );
        }
      }
      sent.push(data);
    },
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const nextListeners = listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
      nextListeners.add(listener);
      listeners.set(type, nextListeners);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as RTCDataChannel;
  const file = new File([makeBytes(MANIFEST_CHUNK_BYTES * 2, 9)], "large.zip", {
    type: "application/zip",
  });
  const plan = buildTransferPlan([file]);
  const progressSnapshots: ResumeProgress[] = [];

  await expect(
    sendFiles(
      channel,
      [file],
      plan,
      noopHandlers,
      0,
      () => true,
      (progress) => {
        progressSnapshots.push(progress);
      },
    ),
  ).rejects.toThrow("Data channel is not open.");

  expect(progressSnapshots.at(-1)?.files[0]?.committedBytes).toBe(MANIFEST_CHUNK_BYTES);
  expect(
    sent
      .map((data) => parseChannelMessage(data))
      .filter((message): message is TransferProtocolMessage => message !== null)
      .filter((message) => message.type === "chunk")
      .map((message) => (message.type === "chunk" ? message.offset : -1)),
  ).toEqual([0]);
});
test("direct transfer marks a file complete only after file-end is sent", async () => {
  const sent: TransferProtocolMessage[] = [];
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send(data: unknown) {
      const message = parseChannelMessage(data);
      if (!message) return;
      sent.push(message);
      if (message.type === "chunk") {
        for (const listener of listeners.get("message") ?? []) {
          listener(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "chunk-commit",
                fileId: message.fileId,
                chunkIndex: message.chunkIndex,
                committedBytes: message.offset + MANIFEST_CHUNK_BYTES,
              } satisfies TransferProtocolMessage),
            }),
          );
        }
      }
    },
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const nextListeners = listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
      nextListeners.add(listener);
      listeners.set(type, nextListeners);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as RTCDataChannel;
  const file = new File([makeBytes(MANIFEST_CHUNK_BYTES, 10)], "large.zip", {
    type: "application/zip",
  });
  const plan = buildTransferPlan([file]);
  const progressSnapshots: Array<{ completed: boolean; lastSentType: string | undefined }> = [];

  await sendFiles(
    channel,
    [file],
    plan,
    noopHandlers,
    0,
    () => true,
    (progress) => {
      progressSnapshots.push({
        completed: progress.files[0]?.completed ?? false,
        lastSentType: sent.at(-1)?.type,
      });
    },
  );

  expect(progressSnapshots).toEqual([
    { completed: false, lastSentType: "chunk" },
    { completed: true, lastSentType: "file-end" },
  ]);
  expect(sent.map((message) => message.type)).toEqual([
    "manifest",
    "file-start",
    "chunk",
    "file-end",
    "complete",
  ]);
});
test("relay transfer advances resumable sender cursor only after receiver chunk-commit", async () => {
  const relayMessages: RelayProtocolMessage[] = [];
  const progressSnapshots: ResumeProgress[] = [];
  let firstChunkSequence: number | null = null;
  const queue = new RelayMessageQueue((data) => {
    handleRelayWire(data, (message, sequence) => {
      relayMessages.push(message);
      queue.acknowledge(sequence);
      if (message.type === "chunk") {
        firstChunkSequence = sequence;
      }
    });
  });
  const file = new File([makeBytes(MANIFEST_CHUNK_BYTES, 11)], "large.zip", {
    type: "application/zip",
  });
  const plan = buildTransferPlan([file]);

  try {
    const transfer = sendFilesViaRelay(
      queue,
      [file],
      plan,
      noopHandlers,
      0,
      () => true,
      (progress) => {
        progressSnapshots.push(structuredClone(progress));
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstChunkSequence).toBeNumber();
    expect(progressSnapshots).toEqual([]);

    queue.commit({
      type: "chunk-commit",
      fileId: "file-1",
      chunkIndex: 0,
      committedBytes: MANIFEST_CHUNK_BYTES,
    });
    await transfer;
  } finally {
    queue.stop();
  }

  expect(progressSnapshots.map((progress) => progress.files[0]?.committedBytes)).toEqual([
    MANIFEST_CHUNK_BYTES,
    MANIFEST_CHUNK_BYTES,
  ]);
  expect(relayMessages.map((message) => message.type)).toEqual([
    "manifest",
    "file-start",
    "chunk",
    "file-end",
    "complete",
  ]);
});

test("relay resume treats a leading completed zero-byte file as already sent before an active offset", async () => {
  const relayMessages: RelayProtocolMessage[] = [];
  const queue = new RelayMessageQueue((data) => {
    handleRelayWire(data, (message, sequence) => {
      relayMessages.push(message);
      queue.acknowledge(sequence);
      commitRelayChunk(queue, message);
    });
  });
  const files = [
    new File([], "empty.txt"),
    new File([makeBytes(MANIFEST_CHUNK_BYTES * 2, 8)], "large.zip", { type: "application/zip" }),
  ];
  const plan = buildTransferPlan(files);

  try {
    await sendFilesViaRelay(
      queue,
      files,
      plan,
      noopHandlers,
      {
        manifestHash: plan.manifestHash,
        files: [
          {
            fileId: "file-1",
            size: 0,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: 0,
            completed: true,
          },
          {
            fileId: "file-2",
            size: fileAt(files, 1).size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: MANIFEST_CHUNK_BYTES,
            completed: false,
          },
        ],
      },
      () => true,
    );
  } finally {
    queue.stop();
  }

  expect(
    relayMessages
      .filter((message) => message.type === "file-start" || message.type === "file-end")
      .map((message) =>
        message.type === "file-start"
          ? { type: message.type, fileId: message.file.id, offset: message.offset }
          : { type: message.type, fileId: message.fileId, bytes: message.bytes },
      ),
  ).toEqual([
    { type: "file-start", fileId: "file-2", offset: MANIFEST_CHUNK_BYTES },
    { type: "file-end", fileId: "file-2", bytes: fileAt(files, 1).size },
  ]);
});
