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

test("OPFS worker survives interleaved write and timer-flush cadence without cached-state failure", async ({
  page,
}) => {
  // Production counterexample: timer flush concurrent with write hit Chromium
  // FileSystemSyncAccessHandle exclusive ownership and surfaced
  // "state cached in an interface object...".
  test.setTimeout(60_000);
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/transfer/receiver-opfs-client.ts";
    const { OpfsWorkerClient, opfsPartName } = await import(modulePath);
    const chunkBytes = 64 * 1024;
    // 2 MiB forces multiple 1 MiB checkpoints plus timer-flush windows.
    const totalChunks = 32;
    const file = {
      id: "opfs-concurrent-e2e",
      name: "concurrent.bin",
      size: totalChunks * chunkBytes,
    };
    const sessionId = `e2e-concurrent-${crypto.randomUUID()}`;
    const allBytes = new Uint8Array(file.size);
    for (let index = 0; index < allBytes.length; index += 1) {
      allBytes[index] = (index * 13) % 251;
    }
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", allBytes));
    const expectedDigest = Array.from(digestBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    const client = new OpfsWorkerClient(sessionId, file);
    const errors: string[] = [];
    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        const offset = chunkIndex * chunkBytes;
        await client.write(chunkIndex, offset, allBytes.slice(offset, offset + chunkBytes).buffer);
        // Yield so the 1s checkpoint timer can arm between chunks on slow paths.
        if (chunkIndex % 4 === 3) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      // Allow a pending timer flush to run before finalize.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const finalized = await client.finalize();
      const received = new Uint8Array(await finalized.file.blob.arrayBuffer());
      URL.revokeObjectURL(finalized.file.url);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(opfsPartName(sessionId, file));
      return {
        ok: true,
        digest: finalized.digest,
        expectedDigest,
        size: received.byteLength,
        errors,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      try {
        client.reset();
      } catch {
        // ignore
      }
      return {
        ok: false,
        digest: "",
        expectedDigest,
        size: 0,
        errors,
      };
    }
  });

  expect(result.ok, `OPFS concurrent path failed: ${result.errors.join(" | ")}`).toBe(true);
  expect(result.errors.join("\n")).not.toContain("state cached in an interface object");
  expect(result.errors.join("\n")).not.toContain("Large-file storage failed");
  expect(result.digest).toBe(result.expectedDigest);
  expect(result.size).toBe(32 * 64 * 1024);
});
