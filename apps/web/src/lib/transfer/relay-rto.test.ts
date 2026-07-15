import { expect, test } from "bun:test";
import { RelayRtoEstimator } from "./relay-rto";

test("Relay RTO uses bounded SRTT and RTTVAR updates", () => {
  const estimator = new RelayRtoEstimator();

  expect(estimator.currentMs).toBe(1_000);
  estimator.record(500);
  expect(estimator.currentMs).toBe(1_500);

  for (let index = 0; index < 8; index += 1) estimator.record(500);
  expect(estimator.currentMs).toBeGreaterThanOrEqual(500);
  expect(estimator.currentMs).toBeLessThan(1_000);

  estimator.record(10_000);
  expect(estimator.currentMs).toBe(4_000);
  estimator.reset();
  expect(estimator.currentMs).toBe(1_000);
});
