import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { TransferFlowController } from "./flow-control";

test("Direct and Relay static profiles keep independent defaults and hard bounds", () => {
  const direct = new TransferFlowController("direct");
  const relay = new TransferFlowController("relay");

  expect(direct.currentMaxInFlightBytes()).toBe(MANIFEST_CHUNK_BYTES * 16);
  expect(direct.hardMaxBytes).toBe(MANIFEST_CHUNK_BYTES * 64);
  expect(relay.currentMaxInFlightBytes()).toBe(MANIFEST_CHUNK_BYTES * 8);
  expect(relay.hardMaxBytes).toBe(MANIFEST_CHUNK_BYTES * 16);

  expect(
    new TransferFlowController("direct", { initialChunks: 100 }).currentMaxInFlightBytes(),
  ).toBe(MANIFEST_CHUNK_BYTES * 64);
  expect(new TransferFlowController("relay", { initialChunks: 1 }).currentMaxInFlightBytes()).toBe(
    MANIFEST_CHUNK_BYTES * 4,
  );
});
