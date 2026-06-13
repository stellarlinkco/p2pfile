import { expect, test } from "bun:test";
import { RelayMessageQueue } from "./relay-queue";
import { buildTransferPlan, sendFiles, sendFilesViaRelay } from "./sender-runtime-helpers";
import type { RelayProtocolMessage, SenderRuntimeHandlers, TransferProtocolMessage } from "./types";

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

async function sha256Buffer(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeBytes(size: number, seed: number) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + seed) % 251;
  }
  return bytes;
}

function fuzzFiles() {
  return [
    new File([makeBytes(0, 1)], "empty.txt", { type: "text/plain" }),
    new File([makeBytes(1, 2)], "one-byte.bin", { type: "application/octet-stream" }),
    new File([makeBytes(64 * 1024 - 1, 3)], "chunk-minus-one.dat"),
    new File([makeBytes(64 * 1024, 4)], "chunk-exact.zip", { type: "application/zip" }),
    new File([makeBytes(64 * 1024 + 1, 5)], "chunk-plus-one.zip", { type: "application/zip" }),
    new File([makeBytes(1024 * 1024 + 17, 6)], "large-archive.zip", {
      type: "application/zip",
    }),
  ];
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
    .filter((data): data is string => typeof data === "string")
    .map((data) => JSON.parse(data) as TransferProtocolMessage)
    .find((message) => message.type === "file-end");
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
    });
    expect(binarySends).toBe(1);
  }
});

test("direct transfer handles deterministic file-size fuzz cases", async () => {
  const sent: unknown[] = [];
  const channel = {
    bufferedAmount: 0,
    readyState: "open",
    send(data: unknown) {
      sent.push(data);
    },
  } as unknown as RTCDataChannel;
  const files = fuzzFiles();
  const plan = buildTransferPlan(files);

  await sendFiles(channel, files, plan, noopHandlers, 0, () => true);

  const protocolMessages = sent
    .filter((data): data is string => typeof data === "string")
    .map((data) => JSON.parse(data) as TransferProtocolMessage);
  const binaryFrameCount = sent.filter((data) => data instanceof ArrayBuffer).length;
  expect(binaryFrameCount).toBe(
    files.reduce((sum, file) => sum + Math.ceil(file.size / (64 * 1024)), 0),
  );
  expect(protocolMessages.at(-1)).toEqual({ type: "complete", totalBytes: plan.totalBytes });

  for (const [index, file] of files.entries()) {
    const fileEnd = protocolMessages.find(
      (message) => message.type === "file-end" && message.fileId === `file-${index + 1}`,
    );
    expect(fileEnd).toMatchObject({
      bytes: file.size,
      digest: await sha256Buffer(await file.arrayBuffer()),
    });
  }
});

test("relay transfer handles deterministic file-size fuzz cases", async () => {
  const relayMessages: RelayProtocolMessage[] = [];
  const queue = new RelayMessageQueue((message) => {
    if (message.type === "relay-message") {
      relayMessages.push(message.payload.message);
      queue.acknowledge(message.payload.sequence);
    }
  });
  const files = fuzzFiles();
  const plan = buildTransferPlan(files);

  try {
    await sendFilesViaRelay(queue, files, plan, noopHandlers, 0, () => true);
  } finally {
    queue.stop();
  }

  expect(relayMessages.at(-1)).toEqual({ type: "complete", totalBytes: plan.totalBytes });
  for (const [index, file] of files.entries()) {
    const fileEnd = relayMessages.find(
      (message) => message.type === "file-end" && message.fileId === `file-${index + 1}`,
    );
    expect(fileEnd).toMatchObject({
      bytes: file.size,
      digest: await sha256Buffer(await file.arrayBuffer()),
    });
  }
});

test("relay file-end keeps the file content digest through relay serialization", async () => {
  const relayMessages: RelayProtocolMessage[] = [];
  const queue = new RelayMessageQueue((message) => {
    if (message.type === "relay-message") {
      relayMessages.push(message.payload.message);
      queue.acknowledge(message.payload.sequence);
    }
  });
  const file = new File(["alpha"], "alpha.txt", { type: "text/plain" });
  const plan = buildTransferPlan([file]);

  try {
    await sendFilesViaRelay(queue, [file], plan, noopHandlers, 0, () => true);
  } finally {
    queue.stop();
  }

  const fileEnd = relayMessages.find((message) => message.type === "file-end");
  expect(fileEnd).toMatchObject({
    fileId: "file-1",
    bytes: file.size,
    digest: await sha256Hex("alpha"),
  });
});
