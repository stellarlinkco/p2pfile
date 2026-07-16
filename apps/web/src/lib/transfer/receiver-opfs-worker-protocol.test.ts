import { expect, test } from "bun:test";
import {
  classifyOpfsWorkerFailure,
  enqueueExclusiveCommand,
} from "./receiver-opfs-worker-protocol";

test("classifies Chromium cached-state InvalidStateError as locked", () => {
  const error = new DOMException(
    "An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.",
    "InvalidStateError",
  );
  expect(classifyOpfsWorkerFailure(error)).toBe("locked");
  expect(
    classifyOpfsWorkerFailure(
      new Error(
        "An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.",
      ),
    ),
  ).toBe("locked");
});

test("classifies quota unsupported write flush and invalid failures", () => {
  expect(classifyOpfsWorkerFailure(new DOMException("disk full", "QuotaExceededError"))).toBe(
    "quota",
  );
  expect(classifyOpfsWorkerFailure(new DOMException("no sync access", "NotSupportedError"))).toBe(
    "unsupported",
  );
  expect(
    classifyOpfsWorkerFailure(new DOMException("file locked", "NoModificationAllowedError")),
  ).toBe("locked");
  expect(classifyOpfsWorkerFailure(new Error("OPFS wrote an incomplete chunk."))).toBe("write");
  expect(classifyOpfsWorkerFailure(new Error("OPFS flush failed."))).toBe("flush");
  expect(classifyOpfsWorkerFailure(new Error("OPFS durable prefix could not be restored."))).toBe(
    "invalid",
  );
  expect(classifyOpfsWorkerFailure(new Error("something else"))).toBe("worker");
});

test("exclusive command queue never runs two OPFS commands concurrently", async () => {
  let inflight = 0;
  let peak = 0;
  const order: string[] = [];

  const run = async (label: string, delayMs: number) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    order.push(`start:${label}`);
    await Bun.sleep(delayMs);
    order.push(`end:${label}`);
    inflight -= 1;
  };

  let chain = Promise.resolve();
  const errors: unknown[] = [];
  chain = enqueueExclusiveCommand(
    chain,
    () => run("write", 30),
    (error) => errors.push(error),
  );
  chain = enqueueExclusiveCommand(
    chain,
    () => run("flush", 10),
    (error) => errors.push(error),
  );
  chain = enqueueExclusiveCommand(
    chain,
    () => run("write2", 5),
    (error) => errors.push(error),
  );
  await chain;

  expect(peak).toBe(1);
  expect(errors).toEqual([]);
  expect(order).toEqual([
    "start:write",
    "end:write",
    "start:flush",
    "end:flush",
    "start:write2",
    "end:write2",
  ]);
});

test("exclusive command queue continues after a failed command", async () => {
  const order: string[] = [];
  let chain = Promise.resolve();
  const errors: string[] = [];
  chain = enqueueExclusiveCommand(
    chain,
    async () => {
      order.push("fail");
      throw new Error("boom");
    },
    (error) => errors.push(error instanceof Error ? error.message : String(error)),
  );
  chain = enqueueExclusiveCommand(
    chain,
    async () => {
      order.push("recover");
    },
    (error) => errors.push(error instanceof Error ? error.message : String(error)),
  );
  await chain;
  expect(order).toEqual(["fail", "recover"]);
  expect(errors).toEqual(["boom"]);
});
