import { afterEach, expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { RelayMessageQueue } from "./relay-queue";
import { decodeBinaryRelayChunkFrame } from "./relay-runtime";

const stopQueues: RelayMessageQueue[] = [];

afterEach(() => {
  for (const queue of stopQueues.splice(0)) {
    queue.stop();
  }
});

function trackQueue(queue: RelayMessageQueue) {
  stopQueues.push(queue);
  return queue;
}

test("relay queue rejects when acknowledgement never arrives", async () => {
  const queue = trackQueue(
    new RelayMessageQueue(() => undefined, {
      ackTimeoutMs: 10,
      initialRtoMs: 60_000,
      maxRtoMs: 60_000,
    }),
  );

  await expect(queue.send({ type: "complete", totalBytes: 1 })).rejects.toThrow(
    "Relay acknowledgement timed out (sequence 0, complete, 1 attempt).",
  );
});

test("relay acknowledgement timeout fails the whole queue instead of orphaning peers", async () => {
  const queue = trackQueue(
    new RelayMessageQueue(() => undefined, {
      ackTimeoutMs: 20,
      initialRtoMs: 60_000,
      maxRtoMs: 60_000,
      maxUnacked: 4,
    }),
  );

  const first = queue.send({ type: "complete", totalBytes: 1 });
  const second = queue.send({ type: "complete", totalBytes: 2 });
  // Keep both promises observed so cascade rejection cannot hang the runner.
  const firstResult = first.then(
    () => "resolved" as const,
    (error: Error) => error.message,
  );
  const secondResult = second.then(
    () => "resolved" as const,
    (error: Error) => error.message,
  );
  await Bun.sleep(40);
  expect(await firstResult).toMatch(/Relay acknowledgement timed out \(/);
  expect(await secondResult).toMatch(/Relay acknowledgement timed out \(/);
  await expect(queue.send({ type: "complete", totalBytes: 3 })).rejects.toThrow(
    "Relay acknowledgement timed out (",
  );
});

test("relay queue fails immediately when the wire send is rejected", async () => {
  const queue = trackQueue(
    new RelayMessageQueue(
      () => {
        throw new Error("Relay signaling disconnected.");
      },
      { ackTimeoutMs: 60_000 },
    ),
  );

  await expect(queue.send({ type: "complete", totalBytes: 1 })).rejects.toThrow(
    "Relay signaling disconnected.",
  );
});

test("relay queue resends only the oldest unacked frame per tick", async () => {
  const sequences: number[] = [];
  const queue = trackQueue(
    new RelayMessageQueue(
      (data) => {
        if (typeof data !== "string") return;
        sequences.push(JSON.parse(data).payload.sequence as number);
      },
      {
        ackTimeoutMs: 60_000,
        initialRtoMs: 20,
        minRtoMs: 20,
        maxRtoMs: 20,
        maxUnacked: 4,
      },
    ),
  );

  const first = queue.send({ type: "complete", totalBytes: 1 });
  const second = queue.send({ type: "complete", totalBytes: 2 });
  const third = queue.send({ type: "complete", totalBytes: 3 });
  void first.catch(() => undefined);
  void second.catch(() => undefined);
  void third.catch(() => undefined);
  await Bun.sleep(5);
  expect(sequences).toEqual([0, 1, 2]);

  await Bun.sleep(45);
  // First resend wave should only retransmit the head-of-line sequence.
  const afterFirstResend = sequences.filter((sequence) => sequence === 0).length;
  const secondResends = sequences.filter((sequence) => sequence === 1).length;
  const thirdResends = sequences.filter((sequence) => sequence === 2).length;
  expect(afterFirstResend).toBeGreaterThanOrEqual(2);
  expect(secondResends).toBe(1);
  expect(thirdResends).toBe(1);

  queue.acknowledge(0);
  await first;
  await Bun.sleep(45);
  expect(sequences.filter((sequence) => sequence === 1).length).toBeGreaterThanOrEqual(2);
  queue.acknowledge(1);
  queue.acknowledge(2);
  await second;
  await third;
});

test("relay queue fails outstanding sends when signaling aborts", async () => {
  const queue = trackQueue(new RelayMessageQueue(() => undefined, { ackTimeoutMs: 60_000 }));
  const pending = queue.send({ type: "complete", totalBytes: 1 });

  queue.fail(new Error("Relay signaling disconnected."));

  await expect(pending).rejects.toThrow("Relay signaling disconnected.");
});

test("relay queue reset rejects active and slot-waiting sends", async () => {
  const queue = trackQueue(
    new RelayMessageQueue(() => undefined, { ackTimeoutMs: 60_000, maxUnacked: 1 }),
  );
  const active = queue.send({ type: "complete", totalBytes: 1 });
  const waiting = queue.send({ type: "complete", totalBytes: 2 });

  queue.reset();

  await expect(active).rejects.toThrow("Transfer restarted.");
  await expect(waiting).rejects.toThrow("Transfer restarted.");
});

test("relay queue keeps sequence identity across restart", async () => {
  const sequences: number[] = [];
  const queue = trackQueue(
    new RelayMessageQueue((data) => {
      if (typeof data !== "string") return;
      const sequence = JSON.parse(data).payload.sequence as number;
      sequences.push(sequence);
      queue.acknowledge(sequence);
    }),
  );

  await queue.send({ type: "complete", totalBytes: 1 });
  queue.reset();
  await queue.send({ type: "complete", totalBytes: 1 });

  expect(sequences).toEqual([0, 1]);
});

test("relay queue ignores stale chunk commits from a prior transfer", async () => {
  const queue = trackQueue(new RelayMessageQueue(() => undefined));
  const commit = queue.awaitCommit("file-1", 0, 10);

  queue.commit({ type: "chunk-commit", fileId: "file-1", chunkIndex: 0, committedBytes: 5 });
  queue.commit({ type: "chunk-commit", fileId: "file-1", chunkIndex: 0, committedBytes: 10 });

  await expect(commit).resolves.toBe(10);
});

test("relay queue nack rejects the matching sequence immediately", async () => {
  const queue = trackQueue(new RelayMessageQueue(() => undefined, { ackTimeoutMs: 60_000 }));
  const pending = queue.send({ type: "complete", totalBytes: 1 });

  queue.nack(0, "peer-unavailable");

  await expect(pending).rejects.toThrow("Relay peer unavailable.");
});

test("relay queue encodes chunks as binary frames by default", async () => {
  const wires: Array<string | ArrayBuffer> = [];
  const queue = trackQueue(
    new RelayMessageQueue((data) => {
      wires.push(data);
      queue.acknowledge(0);
    }, undefined),
  );
  const bytes = new Uint8Array(MANIFEST_CHUNK_BYTES);
  bytes.fill(9);
  await queue.send({
    type: "chunk",
    fileId: "file-1",
    chunkIndex: 0,
    offset: 0,
    bytes: bytes.buffer,
    chunkDigest: "b".repeat(64),
  });

  expect(wires).toHaveLength(1);
  expect(wires[0]).toBeInstanceOf(ArrayBuffer);
  const decoded = decodeBinaryRelayChunkFrame(wires[0] as ArrayBuffer);
  expect(decoded?.sequence).toBe(0);
  expect(decoded?.message.fileId).toBe("file-1");
  expect(decoded?.message.bytes.byteLength).toBe(MANIFEST_CHUNK_BYTES);
});

test("relay queue keeps control messages as JSON envelopes", async () => {
  const wires: Array<string | ArrayBuffer> = [];
  const queue = trackQueue(
    new RelayMessageQueue((data) => {
      wires.push(data);
      queue.acknowledge(0);
    }),
  );

  await queue.send({ type: "complete", totalBytes: 42 });

  expect(typeof wires[0]).toBe("string");
  expect(JSON.parse(wires[0] as string)).toEqual({
    type: "relay-message",
    payload: {
      sequence: 0,
      message: { type: "complete", totalBytes: 42 },
    },
  });
});

test("relay queue resends with exponential backoff instead of a fixed interval", async () => {
  const sentAt: number[] = [];
  const queue = trackQueue(
    new RelayMessageQueue(
      () => {
        sentAt.push(Date.now());
      },
      { ackTimeoutMs: 80, initialRtoMs: 10, minRtoMs: 10, maxRtoMs: 40 },
    ),
  );

  const pending = queue.send({ type: "complete", totalBytes: 1 });
  await expect(pending).rejects.toThrow("Relay acknowledgement timed out (");

  // At least one resend before the terminal timeout (timer granularity may
  // collapse later ticks under HOL retransmission).
  expect(sentAt.length).toBeGreaterThanOrEqual(2);
  const gaps = sentAt.slice(1).map((value, index) => value - (sentAt[index] ?? value));
  // Later gaps should not all equal the initial 10ms fixed cadence.
  expect(Math.max(...gaps)).toBeGreaterThanOrEqual(20);
});

test("healthy 500ms delivery ACK does not trigger a pre-ACK resend", async () => {
  const wires: Array<string | ArrayBuffer> = [];
  const queue = trackQueue(
    new RelayMessageQueue((wire) => {
      wires.push(wire);
    }),
  );
  const pending = queue.send({ type: "complete", totalBytes: 1 });

  await Bun.sleep(500);
  expect(wires).toHaveLength(1);
  queue.acknowledge(0);
  await pending;

  const telemetry = queue.getTelemetry();
  expect(telemetry.applicationResends).toBe(0);
  expect(telemetry.deliveryAckRttMs).toHaveLength(1);
  expect(telemetry.deliveryAckRttMs[0]).toBeGreaterThanOrEqual(450);
  expect(telemetry.pendingWireBytes).toBe(0);
  expect(telemetry.currentRtoMs).toBeGreaterThanOrEqual(1_350);
});

test("ACK after a resend resolves delivery without contaminating RTT sampling", async () => {
  const wires: Array<string | ArrayBuffer> = [];
  const queue = trackQueue(
    new RelayMessageQueue(
      (wire) => {
        wires.push(wire);
      },
      {
        ackTimeoutMs: 500,
        initialRtoMs: 10,
        minRtoMs: 10,
        maxRtoMs: 40,
      },
    ),
  );
  const pending = queue.send({ type: "complete", totalBytes: 1 });
  await Bun.sleep(25);
  queue.acknowledge(0);
  await pending;

  const telemetry = queue.getTelemetry();
  expect(wires.length).toBeGreaterThanOrEqual(2);
  expect(telemetry.applicationResends).toBeGreaterThanOrEqual(1);
  expect(telemetry.deliveryAckRttMs).toEqual([]);
  expect(telemetry.ineligibleDeliveryAckSamples).toBe(1);
  expect(telemetry.transmittedWireBytes).toBeGreaterThan(telemetry.originalWireBytes);
  expect(telemetry.peakPendingWireBytes).toBe(telemetry.originalWireBytes);
  expect(telemetry.pendingWireBytes).toBe(0);
});

test("relay telemetry survives generation reset until it is consumed", async () => {
  const queue = trackQueue(
    new RelayMessageQueue(() => undefined, {
      initialRtoMs: 100,
      minRtoMs: 10,
      maxRtoMs: 1_000,
    }),
  );
  const pending = queue.send({ type: "complete", totalBytes: 1 });
  await Bun.sleep(20);
  queue.acknowledge(0);
  await pending;

  const learnedRtoMs = queue.getTelemetry().currentRtoMs;
  queue.reset();
  const telemetry = queue.takeTelemetry();

  expect(telemetry.deliveryAckRttMs).toHaveLength(1);
  expect(telemetry.currentRtoMs).toBe(learnedRtoMs);
  expect(queue.getTelemetry().deliveryAckRttMs).toEqual([]);
  expect(queue.getTelemetry().currentRtoMs).toBe(100);

  const second = queue.send({ type: "complete", totalBytes: 2 });
  await Bun.sleep(20);
  queue.acknowledge(1);
  await second;
  queue.takeTelemetry();
  queue.reset();
  expect(queue.getTelemetry().currentRtoMs).toBe(100);

  const rolloverPending = queue.send({ type: "complete", totalBytes: 3 });
  const livePendingBytes = queue.pendingWireByteLength();
  expect(livePendingBytes).toBeGreaterThan(0);
  expect(queue.takeTelemetry().pendingWireBytes).toBe(livePendingBytes);
  expect(queue.pendingWireByteLength()).toBe(livePendingBytes);
  await Bun.sleep(20);
  queue.acknowledge(2);
  await rolloverPending;
  const rolloverLearnedRtoMs = queue.getTelemetry().currentRtoMs;
  queue.reset();
  const rolloverTelemetry = queue.takeTelemetry();
  expect(rolloverTelemetry.deliveryAckRttMs).toHaveLength(1);
  expect(rolloverTelemetry.currentRtoMs).toBe(rolloverLearnedRtoMs);

  const unacknowledged = queue.send({ type: "complete", totalBytes: 4 });
  expect(queue.pendingWireByteLength()).toBeGreaterThan(0);
  queue.reset();
  await expect(unacknowledged).rejects.toThrow("Transfer restarted.");
  expect(queue.pendingWireByteLength()).toBe(0);
});

test("relay queue limits unacked messages before accepting more sends", async () => {
  const wires: Array<string | ArrayBuffer> = [];
  const queue = trackQueue(
    new RelayMessageQueue(
      (data) => {
        wires.push(data);
      },
      { ackTimeoutMs: 60_000, maxUnacked: 1 },
    ),
  );

  const first = queue.send({ type: "complete", totalBytes: 1 });
  const secondPromise = queue.send({ type: "complete", totalBytes: 2 });
  const thirdPromise = queue.send({ type: "complete", totalBytes: 3 });
  await Bun.sleep(5);
  expect(wires).toHaveLength(1);

  queue.acknowledge(0);
  await first;
  await Bun.sleep(5);
  expect(wires).toHaveLength(2);
  expect(wires).not.toHaveLength(3);

  queue.acknowledge(1);
  await Bun.sleep(5);
  expect(wires).toHaveLength(3);
  queue.acknowledge(2);
  await secondPromise;
  await thirdPromise;
});

test("relay queue reset rejects a send whose slot was just released", async () => {
  const wires: Array<string | ArrayBuffer> = [];
  const queue = trackQueue(
    new RelayMessageQueue((data) => wires.push(data), {
      ackTimeoutMs: 60_000,
      maxUnacked: 1,
    }),
  );
  const first = queue.send({ type: "complete", totalBytes: 1 });
  const waiting = queue.send({ type: "complete", totalBytes: 2 });

  queue.acknowledge(0);
  queue.reset();

  await first;
  await expect(waiting).rejects.toThrow("Transfer restarted.");
  expect(wires).toHaveLength(1);
});

test("relay commit timeout arms only after delivery acknowledgement", async () => {
  const queue = trackQueue(
    new RelayMessageQueue(() => undefined, {
      ackTimeoutMs: 60_000,
      commitTimeoutMs: 20,
    }),
  );

  const commit = queue.awaitCommit("file-1", 0, MANIFEST_CHUNK_BYTES);
  // Delivery never completes, so commit timer must not fire yet.
  await Bun.sleep(40);
  let settled = false;
  void commit.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Bun.sleep(5);
  expect(settled).toBe(false);

  // Simulate delivery success path: arm after ack.
  queue.armCommitTimeout("file-1", 0);
  await expect(commit).rejects.toThrow("Relay chunk commit timed out.");
});
