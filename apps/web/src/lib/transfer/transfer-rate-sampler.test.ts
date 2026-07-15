import { expect, test } from "bun:test";
import { TransferRateSampler } from "./transfer-rate-sampler";

const MEBIBYTE = 1024 * 1024;

test("rolling speed stays representative and decays after useful progress stops", () => {
  const sampler = new TransferRateSampler();
  const published: Array<{ at: number; speed: number }> = [];

  for (let at = 0; at <= 4_000; at += 100) {
    const speed = sampler.sample((MEBIBYTE * at) / 1_000, at);
    if (speed !== undefined) published.push({ at, speed });
  }

  const warmed = published.filter((sample) => sample.at >= 3_000);
  expect(warmed.length).toBeGreaterThan(0);
  expect(warmed.every((sample) => Math.abs(sample.speed - MEBIBYTE) <= MEBIBYTE * 0.2)).toBe(true);
  for (let index = 1; index < published.length; index += 1) {
    expect((published[index]?.at ?? 0) - (published[index - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
      250,
    );
  }

  let stoppedSpeed: number | undefined;
  for (let at = 4_100; at <= 6_500; at += 100) {
    const speed = sampler.sample(4 * MEBIBYTE, at);
    if (speed !== undefined) stoppedSpeed = speed;
  }
  expect(stoppedSpeed).toBe(0);
});
