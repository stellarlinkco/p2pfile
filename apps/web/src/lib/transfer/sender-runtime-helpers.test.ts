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
