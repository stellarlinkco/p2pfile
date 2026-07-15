import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { RelayMessageQueue } from "./relay-queue";
import {
  decodeBinaryChunk,
  decodeBinaryRelayChunkFrame,
  encodeChunk,
  toRelayMessage,
} from "./relay-runtime";
import { buildTransferPlan, sendFiles, sendFilesViaRelay } from "./sender-runtime-helpers";
import type {
  BrowserSignalMessage,
  RelayProtocolMessage,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

/**
 * Feedback loop for transfer throughput ceilings.
 *
 * After the single-file pipeline change, a multi-chunk window must produce
 * peakInFlight > 1 and beat the old stop-and-wait RTT bound under controlled
 * commit delay.
 */

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

function formatKbps(bytesPerSecond: number) {
  return bytesPerSecond / 1024;
}

function fixedFlow(maxInFlightBytes: number) {
  return { currentMaxInFlightBytes: () => maxInFlightBytes };
}

async function measureDirectThroughput(options: {
  fileBytes: number;
  commitDelayMs: number;
  maxInFlightBytes?: number;
}) {
  const file = new File([makeBytes(options.fileBytes, 7)], "ceiling.bin", {
    type: "application/octet-stream",
  });
  const plan = buildTransferPlan([file]);
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  let chunkSends = 0;
  let peakInFlight = 0;
  let openCommits = 0;

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
      if (message?.type !== "chunk") return;

      chunkSends += 1;
      openCommits += 1;
      peakInFlight = Math.max(peakInFlight, openCommits);
      const committedBytes =
        message.offset +
        (message.bytesBase64 ? atob(message.bytesBase64).length : message.bytes.byteLength);

      setTimeout(() => {
        openCommits -= 1;
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
      }, options.commitDelayMs);
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

  const started = performance.now();
  await sendFiles(
    channel,
    [file],
    plan,
    noopHandlers,
    0,
    () => true,
    undefined,
    options.maxInFlightBytes
      ? { flowControl: fixedFlow(options.maxInFlightBytes), maxActiveFiles: 1 }
      : { maxActiveFiles: 1 },
  );
  const elapsedMs = performance.now() - started;
  const bytesPerSecond = options.fileBytes / (elapsedMs / 1000);

  return {
    bytesPerSecond,
    chunkSends,
    elapsedMs,
    peakInFlight,
  };
}

async function measureRelayThroughput(options: {
  fileBytes: number;
  commitDelayMs: number;
  maxInFlightBytes?: number;
}) {
  const file = new File([makeBytes(options.fileBytes, 11)], "relay-ceiling.bin", {
    type: "application/octet-stream",
  });
  const plan = buildTransferPlan([file]);
  let openCommits = 0;
  let peakInFlight = 0;
  let chunkSends = 0;

  const queue = new RelayMessageQueue((data: string | ArrayBuffer) => {
    if (typeof data === "string") {
      const message = JSON.parse(data) as BrowserSignalMessage;
      if (message.type !== "relay-message") return;
      queue.acknowledge(message.payload.sequence);
      if (message.payload.message.type !== "chunk") return;
      chunkSends += 1;
      openCommits += 1;
      peakInFlight = Math.max(peakInFlight, openCommits);
      const chunk = message.payload.message;
      setTimeout(() => {
        openCommits -= 1;
        queue.commit({
          type: "chunk-commit",
          fileId: chunk.fileId,
          chunkIndex: chunk.chunkIndex,
          committedBytes: chunk.offset + atob(chunk.bytesBase64).length,
        });
      }, options.commitDelayMs);
      return;
    }
    const decoded = decodeBinaryRelayChunkFrame(data);
    if (!decoded) return;
    queue.acknowledge(decoded.sequence);
    chunkSends += 1;
    openCommits += 1;
    peakInFlight = Math.max(peakInFlight, openCommits);
    const chunk = toRelayMessage(decoded.message) as Extract<
      RelayProtocolMessage,
      { type: "chunk" }
    >;
    setTimeout(() => {
      openCommits -= 1;
      queue.commit({
        type: "chunk-commit",
        fileId: chunk.fileId,
        chunkIndex: chunk.chunkIndex,
        committedBytes: chunk.offset + atob(chunk.bytesBase64).length,
      });
    }, options.commitDelayMs);
  });

  try {
    const started = performance.now();
    await sendFilesViaRelay(
      queue,
      [file],
      plan,
      noopHandlers,
      0,
      () => true,
      undefined,
      options.maxInFlightBytes
        ? { flowControl: fixedFlow(options.maxInFlightBytes), maxActiveFiles: 1 }
        : { maxActiveFiles: 1 },
    );
    const elapsedMs = performance.now() - started;
    return {
      bytesPerSecond: options.fileBytes / (elapsedMs / 1000),
      chunkSends,
      elapsedMs,
      peakInFlight,
    };
  } finally {
    queue.stop();
  }
}

test("pipelined direct transfer exceeds stop-and-wait ceiling at 200ms commit RTT", async () => {
  // 8 chunks, window 8, RTT 200ms.
  // Old stop-and-wait ideal: 512 KiB / 1.6s = 320 KB/s.
  // Pipelined ideal: roughly one RTT for the whole window after first fill.
  const result = await measureDirectThroughput({
    fileBytes: MANIFEST_CHUNK_BYTES * 8,
    commitDelayMs: 200,
    maxInFlightBytes: MANIFEST_CHUNK_BYTES * 8,
  });

  expect(result.chunkSends).toBe(8);
  expect(result.peakInFlight).toBeGreaterThan(1);
  expect(result.peakInFlight).toBeGreaterThanOrEqual(4);

  const kbps = formatKbps(result.bytesPerSecond);
  // Must clearly beat the old ~320 KB/s stop-and-wait bound.
  expect(kbps).toBeGreaterThan(400);

  console.log(
    `[throughput-ceiling] pipelined direct @200ms RTT: ${kbps.toFixed(1)} KB/s, peakInFlight=${result.peakInFlight}, elapsed=${result.elapsedMs.toFixed(0)}ms`,
  );
});

test("default direct window fills the 1 MiB commit budget under delayed commits", async () => {
  const result = await measureDirectThroughput({
    fileBytes: MANIFEST_CHUNK_BYTES * 16,
    commitDelayMs: 100,
  });

  expect(result.chunkSends).toBe(16);
  expect(result.peakInFlight).toBe(16);
  expect(formatKbps(result.bytesPerSecond)).toBeGreaterThan(1_000);

  console.log(
    `[throughput-ceiling] default direct @100ms RTT: ${formatKbps(result.bytesPerSecond).toFixed(1)} KB/s, peakInFlight=${result.peakInFlight}`,
  );
});

test("pipelined relay transfer also raises peak in-flight above one", async () => {
  const result = await measureRelayThroughput({
    fileBytes: MANIFEST_CHUNK_BYTES * 4,
    commitDelayMs: 200,
    maxInFlightBytes: MANIFEST_CHUNK_BYTES * 4,
  });

  expect(result.chunkSends).toBe(4);
  expect(result.peakInFlight).toBeGreaterThan(1);
  const kbps = formatKbps(result.bytesPerSecond);
  expect(kbps).toBeGreaterThan(200);

  console.log(
    `[throughput-ceiling] pipelined relay @200ms RTT: ${kbps.toFixed(1)} KB/s, peakInFlight=${result.peakInFlight}`,
  );
});

test("default relay window remains bounded under delayed commits", async () => {
  const result = await measureRelayThroughput({
    fileBytes: MANIFEST_CHUNK_BYTES * 8,
    commitDelayMs: 100,
  });

  expect(result.chunkSends).toBe(8);
  expect(result.peakInFlight).toBe(8);
  expect(formatKbps(result.bytesPerSecond)).toBeGreaterThan(400);
});
test("Direct and Relay expose bounded commit, delivery, retry, and byte telemetry", async () => {
  const target = globalThis as {
    __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
  };
  target.__P2PFILE_TEST_TRANSFER_EVENTS__ = [];
  try {
    await measureDirectThroughput({
      fileBytes: MANIFEST_CHUNK_BYTES * 2,
      commitDelayMs: 5,
      maxInFlightBytes: MANIFEST_CHUNK_BYTES * 2,
    });
    await measureRelayThroughput({
      fileBytes: MANIFEST_CHUNK_BYTES * 2,
      commitDelayMs: 5,
      maxInFlightBytes: MANIFEST_CHUNK_BYTES * 2,
    });

    const events = target.__P2PFILE_TEST_TRANSFER_EVENTS__;
    const direct = events.find((event) => event.type === "direct-telemetry");
    const relayCommit = events.find((event) => event.type === "relay-telemetry");
    const relayDelivery = events.find((event) => event.type === "relay-delivery-telemetry");
    expect(direct?.commitRttMs as number[]).toHaveLength(2);
    expect(direct?.peakInFlightBytes).toBe(MANIFEST_CHUNK_BYTES * 2);
    expect(Number(direct?.usefulBytesPerSecond)).toBeGreaterThan(0);
    expect(relayCommit?.commitRttMs as number[]).toHaveLength(2);
    expect(Array.isArray(relayDelivery?.deliveryAckRttMs)).toBe(true);
    expect(Number(relayDelivery?.peakPendingWireBytes)).toBeGreaterThan(0);
    expect(Number(relayDelivery?.wireByteAmplification)).toBeGreaterThanOrEqual(1);
  } finally {
    delete target.__P2PFILE_TEST_TRANSFER_EVENTS__;
  }
});

test("hand-rolled base64 encode of one chunk is a measurable main-thread tax", () => {
  const bytes = makeBytes(MANIFEST_CHUNK_BYTES, 3).buffer;
  const rounds = 20;
  const started = performance.now();
  for (let index = 0; index < rounds; index += 1) {
    encodeChunk(bytes);
  }
  const elapsedMs = performance.now() - started;
  const perChunkMs = elapsedMs / rounds;

  expect(perChunkMs).toBeGreaterThan(0);
  console.log(
    `[throughput-ceiling] encodeChunk(64KiB) avg ${perChunkMs.toFixed(2)}ms over ${rounds} rounds`,
  );
});
