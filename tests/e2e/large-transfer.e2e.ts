import { expect, type Page, test } from "@playwright/test";
import {
  createSession,
  makeSizedTestFile,
  newReceiverPage,
  openReceiver,
  slowDirectChunks,
} from "./p2p-file-v1.support";
import { writeEvidence, writeEvidenceScreenshot } from "./worker-share-link.support";

const MANIFEST_CHUNK_BYTES = 64 * 1024;

type OpfsWorkerIoTrace = {
  outstandingWriteBytes: number;
  peakOutstandingWriteBytes: number;
  transferredWrites: number;
  writeSizes: number[];
};

async function observeOpfsWorkerIo(page: Page) {
  await page.addInitScript(() => {
    const trace: OpfsWorkerIoTrace = {
      outstandingWriteBytes: 0,
      peakOutstandingWriteBytes: 0,
      transferredWrites: 0,
      writeSizes: [],
    };
    Object.assign(window, { __P2PFILE_TEST_OPFS_WORKER_IO__: trace });
    const NativeWorker = window.Worker;
    class InstrumentedWorker extends NativeWorker {
      private readonly pendingWriteBytes = new Map<number, number>();

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const response = event.data;
          if (
            typeof response !== "object" ||
            response === null ||
            !("requestId" in response) ||
            typeof response.requestId !== "number"
          ) {
            return;
          }
          const bytes = this.pendingWriteBytes.get(response.requestId);
          if (bytes === undefined) return;
          this.pendingWriteBytes.delete(response.requestId);
          trace.outstandingWriteBytes -= bytes;
        });
      }

      postMessage(
        message: unknown,
        transferOrOptions?: StructuredSerializeOptions | Transferable[],
      ) {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "write" &&
          "bytes" in message &&
          message.bytes instanceof ArrayBuffer
        ) {
          if ("requestId" in message && typeof message.requestId === "number") {
            this.pendingWriteBytes.set(message.requestId, message.bytes.byteLength);
            trace.outstandingWriteBytes += message.bytes.byteLength;
            trace.peakOutstandingWriteBytes = Math.max(
              trace.peakOutstandingWriteBytes,
              trace.outstandingWriteBytes,
            );
          }
          trace.writeSizes.push(message.bytes.byteLength);
          if (Array.isArray(transferOrOptions) && transferOrOptions.includes(message.bytes)) {
            trace.transferredWrites += 1;
          }
        }
        super.postMessage(message, transferOrOptions);
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: InstrumentedWorker,
    });
  });
}

test.describe("large transfer coverage", () => {
  test("Direct Transfer completes a large ZIP through worker-owned OPFS", async ({ page }) => {
    test.setTimeout(90_000);
    const files = [makeSizedTestFile("large-transfer.zip", 2 * 1024 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });
    await observeOpfsWorkerIo(receiver);

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();

      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(receiver.getByRole("button", { name: "保存 large-transfer.zip" })).toBeVisible();
      const workerIo = await receiver.evaluate(
        () =>
          (
            window as Window & {
              __P2PFILE_TEST_OPFS_WORKER_IO__: OpfsWorkerIoTrace;
            }
          ).__P2PFILE_TEST_OPFS_WORKER_IO__,
      );
      expect(workerIo.writeSizes).toHaveLength(files[0].buffer.byteLength / MANIFEST_CHUNK_BYTES);
      expect(Math.max(...workerIo.writeSizes)).toBe(MANIFEST_CHUNK_BYTES);
      expect(workerIo.writeSizes.reduce((sum, size) => sum + size, 0)).toBe(
        files[0].buffer.byteLength,
      );
      expect(workerIo.transferredWrites).toBe(workerIo.writeSizes.length);
      expect(workerIo.outstandingWriteBytes).toBe(0);
      expect(workerIo.peakOutstandingWriteBytes).toBe(MANIFEST_CHUNK_BYTES);

      const screenshotPath = await writeEvidenceScreenshot(
        receiver,
        "val-rel-012-streaming-sink.png",
      );
      await writeEvidence("val-rel-012-streaming-sink-dom-trace.json", {
        assertionId: "VAL-REL-012",
        workUnitId: "wu-1207294a",
        evidenceSource: "controlled",
        shareLink,
        fileName: files[0].name,
        fileSize: files[0].buffer.byteLength,
        modeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
        completedSessionVisible: true,
        saveActionVisible: true,
        workerIo,
        screenshotPath,
      });
    } finally {
      await receiver.close();
    }
  });

  test("Direct Transfer resumes a durable large-file checkpoint after receiver reload", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const files = [makeSizedTestFile("reload-resume.zip", 4 * 1024 * 1024, "application/zip")];
    await slowDirectChunks(page, 40);
    const shareLink = await createSession(page, files, { fallback: false });
    const sessionId = new URL(shareLink).pathname.split("/").pop();
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(receiver.getByTestId("session-status")).toContainText(
        /Receiving|接收|manifest/i,
        { timeout: 20_000 },
      );
      const readDurableCheckpoint = () =>
        receiver.evaluate((id) => {
          const raw = id ? localStorage.getItem(`p2pfile-active-progress:${id}`) : null;
          if (!raw) return 0;
          const progress = JSON.parse(raw) as { committedBytes?: number };
          return typeof progress.committedBytes === "number" ? progress.committedBytes : 0;
        }, sessionId);
      await expect
        .poll(readDurableCheckpoint, { timeout: 20_000 })
        .toBeGreaterThan(MANIFEST_CHUNK_BYTES * 2);
      const durableCheckpoint = await readDurableCheckpoint();
      expect(durableCheckpoint % MANIFEST_CHUNK_BYTES).toBe(0);
      expect(durableCheckpoint).toBeLessThan(files[0].buffer.byteLength);

      await receiver.reload();
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();

      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(receiver.getByRole("button", { name: "保存 reload-resume.zip" })).toBeVisible();
      await writeEvidence("val-rel-012-opfs-resume-read-trace.json", {
        assertionId: "VAL-REL-012",
        workUnitId: "wu-1207294a",
        evidenceSource: "controlled",
        shareLink,
        fileName: files[0].name,
        fileSize: files[0].buffer.byteLength,
        durableCheckpoint,
        chunkAligned: durableCheckpoint % MANIFEST_CHUNK_BYTES === 0,
        completedAfterReload: true,
      });
    } finally {
      await receiver.close();
    }
  });
});
