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
    new RelayMessageQueue(() => undefined, { ackTimeoutMs: 10, resendMs: 60_000 }),
  );

  await expect(queue.send({ type: "complete", totalBytes: 1 })).rejects.toThrow(
    "Relay acknowledgement timed out (sequence 0, complete, 1 attempt).",
  );
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
      { ackTimeoutMs: 80, resendMs: 10, maxResendMs: 40 },
    ),
  );

  const pending = queue.send({ type: "complete", totalBytes: 1 });
  await expect(pending).rejects.toThrow("Relay acknowledgement timed out (");

  expect(sentAt.length).toBeGreaterThanOrEqual(3);
  const gaps = sentAt.slice(1).map((value, index) => value - (sentAt[index] ?? value));
  // Later gaps should not all equal the initial 10ms fixed cadence.
  expect(Math.max(...gaps)).toBeGreaterThanOrEqual(20);
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
