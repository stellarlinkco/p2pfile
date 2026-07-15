import { expect, test } from "@playwright/test";

test("dedicated OPFS worker resumes a durable prefix with exact final integrity", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/transfer/receiver-opfs-client.ts";
    const { OpfsWorkerClient, opfsPartName } = await import(modulePath);
    const chunkBytes = 64 * 1024;
    const durablePrefixBytes = 16 * chunkBytes;
    const file = {
      id: "opfs-worker-e2e",
      name: "worker.bin",
      size: durablePrefixBytes + chunkBytes,
    };
    const sessionId = `e2e-${crypto.randomUUID()}`;
    const allBytes = new Uint8Array(file.size);
    for (let index = 0; index < allBytes.length; index += 1) {
      allBytes[index] = index % 251;
    }
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", allBytes));
    const expectedDigest = Array.from(digestBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    const firstClient = new OpfsWorkerClient(sessionId, file);
    for (let chunkIndex = 0; chunkIndex < 16; chunkIndex += 1) {
      const offset = chunkIndex * chunkBytes;
      await firstClient.write(
        chunkIndex,
        offset,
        allBytes.slice(offset, offset + chunkBytes).buffer,
      );
    }
    const checkpointBytes = firstClient.durableBytes;
    firstClient.reset();

    const resumedClient = new OpfsWorkerClient(sessionId, file);
    const restoredBytes = await resumedClient.restore(checkpointBytes);
    await resumedClient.write(16, durablePrefixBytes, allBytes.slice(durablePrefixBytes).buffer);
    const finalized = await resumedClient.finalize();
    const received = new Uint8Array(await finalized.file.blob.arrayBuffer());
    URL.revokeObjectURL(finalized.file.url);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(opfsPartName(sessionId, file));

    return {
      checkpointBytes,
      digest: finalized.digest,
      expectedDigest,
      size: received.byteLength,
      firstByte: received[0],
      lastByte: received[received.length - 1],
      restoredBytes,
    };
  });

  expect(result).toEqual({
    checkpointBytes: 1024 * 1024,
    digest: result.expectedDigest,
    expectedDigest: result.expectedDigest,
    size: 17 * 64 * 1024,
    firstByte: 0,
    lastByte: (17 * 64 * 1024 - 1) % 251,
    restoredBytes: 1024 * 1024,
  });
});

test("browser rolling speed sampler stays stable and decays after a stall", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/transfer/transfer-rate-sampler.ts";
    const { TransferRateSampler } = await import(modulePath);
    const sampler = new TransferRateSampler();
    const mebibyte = 1024 * 1024;
    let warmedSpeed = 0;
    for (let at = 0; at <= 4_000; at += 100) {
      const speed = sampler.sample((mebibyte * at) / 1_000, at);
      if (speed !== undefined) warmedSpeed = speed;
    }
    let stoppedSpeed = warmedSpeed;
    for (let at = 4_100; at <= 6_500; at += 100) {
      const speed = sampler.sample(4 * mebibyte, at);
      if (speed !== undefined) stoppedSpeed = speed;
    }
    return { warmedSpeed, stoppedSpeed };
  });

  expect(result.warmedSpeed).toBeGreaterThanOrEqual(0.8 * 1024 * 1024);
  expect(result.warmedSpeed).toBeLessThanOrEqual(1.2 * 1024 * 1024);
  expect(result.stoppedSpeed).toBe(0);
});
