import { expect, test } from "bun:test";
import { RelayMessageQueue } from "./relay-queue";
import { decodeBinaryChunk, decodeBinaryRelayChunkFrame, toRelayMessage } from "./relay-runtime";
import { buildTransferPlan, sendFiles, sendFilesViaRelay } from "./sender-runtime-helpers";
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

function commitRelayChunk(queue: RelayMessageQueue, message: RelayProtocolMessage) {
  if (message.type !== "chunk") return;
  queue.commit({
    type: "chunk-commit",
    fileId: message.fileId,
    chunkIndex: message.chunkIndex,
    committedBytes: message.offset + atob(message.bytesBase64).length,
  });
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
    .map((data) => parseChannelMessage(data))
    .filter((message): message is TransferProtocolMessage => message !== null);
  const chunkFrameCount = protocolMessages.filter((message) => message.type === "chunk").length;
  expect(chunkFrameCount).toBe(
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
  const queue = new RelayMessageQueue((data) => {
    handleRelayWire(data, (message, sequence) => {
      relayMessages.push(message);
      queue.acknowledge(sequence);
      commitRelayChunk(queue, message);
    });
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
  const queue = new RelayMessageQueue((data) => {
    handleRelayWire(data, (message, sequence) => {
      relayMessages.push(message);
      queue.acknowledge(sequence);
      commitRelayChunk(queue, message);
    });
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
