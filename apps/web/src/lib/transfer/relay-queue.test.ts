import { afterEach, expect, test } from "bun:test";
import { RelayMessageQueue } from "./relay-queue";

const stopQueues: RelayMessageQueue[] = [];

afterEach(() => {
  for (const queue of stopQueues.splice(0)) {
    queue.stop();
  }
});
test("relay queue rejects when acknowledgement never arrives", async () => {
  const queue = new RelayMessageQueue(() => undefined, { ackTimeoutMs: 10, resendMs: 5 });
  stopQueues.push(queue);

  await expect(queue.send({ type: "complete", totalBytes: 1 })).rejects.toThrow(
    "Relay acknowledgement timed out.",
  );
});
