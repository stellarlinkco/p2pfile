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

type StreamingSinkTrace = {
  opfsGetDirectoryCalls: number;
  fileHandles: string[];
  writableOpens: Array<{ name: string; keepExistingData: boolean | null }>;
  writes: Array<{ name: string; position: number; byteLength: number }>;
  reads: Array<{ name: string; start: number; end: number; byteLength: number }>;
  closes: number;
  blobConstructions: Array<{ partCount: number; totalBytes: number; type: string }>;
};

async function recordStreamingSinkTrace(page: Page) {
  await page.addInitScript(() => {
    const trace: StreamingSinkTrace = {
      opfsGetDirectoryCalls: 0,
      fileHandles: [],
      writableOpens: [],
      writes: [],
      closes: 0,
      reads: [],
      blobConstructions: [],
    };
    Object.defineProperty(window, "__P2PFILE_STREAMING_SINK_TRACE__", {
      configurable: true,
      value: trace,
    });

    function byteLengthOf(value: unknown) {
      if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof NativeBlob) return value.size;
      return 0;
    }

    function payloadOf(command: unknown) {
      if (command && typeof command === "object" && "data" in command) {
        return (command as { data?: unknown }).data;
      }
      return command;
    }

    function positionOf(command: unknown) {
      if (command && typeof command === "object" && "position" in command) {
        const position = (command as { position?: unknown }).position;
        return typeof position === "number" ? position : 0;
      }
      return 0;
    }

    const NativeBlob = window.Blob;
    Object.defineProperty(window, "Blob", {
      configurable: true,
      value: new Proxy(NativeBlob, {
        construct(target, args, newTarget) {
          const parts = Array.isArray(args[0]) ? args[0] : [];
          const options = args[1] as { type?: string } | undefined;
          trace.blobConstructions.push({
            partCount: parts.length,
            totalBytes: parts.reduce((sum, part) => sum + byteLengthOf(part), 0),
            type: options?.type ?? "",
          });
          return Reflect.construct(target, args, newTarget);
        },
      }),
    });

    const originalGetDirectory = navigator.storage?.getDirectory?.bind(navigator.storage);
    if (!originalGetDirectory) return;

    Object.defineProperty(navigator.storage, "getDirectory", {
      configurable: true,
      value: async () => {
        trace.opfsGetDirectoryCalls += 1;
        const root = await originalGetDirectory();
        return new Proxy(root, {
          get(rootTarget, property, receiver) {
            const value = Reflect.get(rootTarget, property, receiver);
            if (property !== "getFileHandle" || typeof value !== "function") return value;
            return async (name: string, options?: FileSystemGetFileOptions) => {
              trace.fileHandles.push(name);
              const handle = await Reflect.apply(value, rootTarget, [name, options]);
              return new Proxy(handle, {
                get(handleTarget, handleProperty, handleReceiver) {
                  const handleValue = Reflect.get(handleTarget, handleProperty, handleReceiver);
                  if (handleProperty === "getFile" && typeof handleValue === "function") {
                    return async () => {
                      const file = await Reflect.apply(handleValue, handleTarget, []);
                      const nativeSlice = file.slice.bind(file);
                      Object.defineProperty(file, "slice", {
                        configurable: true,
                        value(start?: number, end?: number, contentType?: string) {
                          const readStart = typeof start === "number" ? start : 0;
                          const readEnd = Math.min(
                            typeof end === "number" ? end : file.size,
                            file.size,
                          );
                          const slice = nativeSlice(start, end, contentType);
                          trace.reads.push({
                            name,
                            start: readStart,
                            end: readEnd,
                            byteLength: slice.size,
                          });
                          return slice;
                        },
                      });
                      return file;
                    };
                  }
                  if (handleProperty !== "createWritable" || typeof handleValue !== "function") {
                    return typeof handleValue === "function"
                      ? handleValue.bind(handleTarget)
                      : handleValue;
                  }
                  return async (writableOptions?: FileSystemCreateWritableOptions) => {
                    trace.writableOpens.push({
                      name,
                      keepExistingData: writableOptions?.keepExistingData ?? null,
                    });
                    const writable = await Reflect.apply(handleValue, handleTarget, [
                      writableOptions,
                    ]);
                    return new Proxy(writable, {
                      get(writableTarget, writableProperty, writableReceiver) {
                        const writableValue = Reflect.get(
                          writableTarget,
                          writableProperty,
                          writableReceiver,
                        );
                        if (writableProperty === "write" && typeof writableValue === "function") {
                          return async (command: unknown) => {
                            trace.writes.push({
                              name,
                              position: positionOf(command),
                              byteLength: byteLengthOf(payloadOf(command)),
                            });
                            return Reflect.apply(writableValue, writableTarget, [command]);
                          };
                        }
                        if (writableProperty === "close" && typeof writableValue === "function") {
                          return async () => {
                            trace.closes += 1;
                            return Reflect.apply(writableValue, writableTarget, []);
                          };
                        }
                        return typeof writableValue === "function"
                          ? writableValue.bind(writableTarget)
                          : writableValue;
                      },
                    });
                  };
                },
              });
            };
          },
        });
      },
    });
  });
}

async function readStreamingSinkTrace(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __P2PFILE_STREAMING_SINK_TRACE__?: StreamingSinkTrace;
        }
      ).__P2PFILE_STREAMING_SINK_TRACE__ ?? null,
  );
}

test.describe("large transfer coverage", () => {
  test("direct transfer streams a large zip through OPFS without whole-file Blob aggregation", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const files = [makeSizedTestFile("large-transfer.zip", 2 * 1024 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });
    await recordStreamingSinkTrace(receiver);

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

      const trace = await readStreamingSinkTrace(receiver);
      if (!trace) throw new Error("Missing streaming sink trace.");
      const totalWrittenBytes = trace.writes.reduce((sum, write) => sum + write.byteLength, 0);
      const maxWriteBytes = Math.max(...trace.writes.map((write) => write.byteLength));
      const maxReadBytes =
        trace.reads.length > 0 ? Math.max(...trace.reads.map((read) => read.byteLength)) : 0;
      const fullFileBlobAggregations = trace.blobConstructions.filter(
        (blob) => blob.partCount > 1 && blob.totalBytes >= files[0].buffer.byteLength,
      );

      expect(trace.opfsGetDirectoryCalls).toBeGreaterThan(0);
      expect(
        trace.fileHandles.some((name) => name.endsWith(`-${files[0].buffer.byteLength}.part`)),
      ).toBe(true);
      expect(trace.writes.length).toBeGreaterThan(1);
      expect(totalWrittenBytes).toBe(files[0].buffer.byteLength);
      expect(maxWriteBytes).toBeLessThanOrEqual(MANIFEST_CHUNK_BYTES);
      expect(trace.writableOpens.every((open) => open.keepExistingData === true)).toBe(true);
      // Durable resume still checkpoints OPFS, but not once per 64 KiB chunk.
      // Closing every write was measured at ~20-30 KB/s on Chromium DataChannel.
      expect(trace.closes).toBeGreaterThan(0);
      expect(trace.closes).toBeLessThan(trace.writes.length);
      expect(trace.writableOpens.length).toBeGreaterThan(0);
      expect(trace.writableOpens.length).toBeLessThanOrEqual(trace.writes.length);
      expect(fullFileBlobAggregations).toEqual([]);

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
        opfsGetDirectoryCalls: trace.opfsGetDirectoryCalls,
        fileHandles: trace.fileHandles,
        writes: trace.writes,
        writableOpens: trace.writableOpens,
        closes: trace.closes,
        reads: trace.reads,
        blobConstructions: trace.blobConstructions,
        maxWriteBytes,
        maxReadBytes,
        totalWrittenBytes,
        fullFileBlobAggregations,
        screenshotPath,
      });
    } finally {
      await receiver.close();
    }
  });

  test("Direct Transfer resumes a large ZIP after receiver reload", async ({ page }) => {
    test.setTimeout(90_000);
    const files = [makeSizedTestFile("reload-resume.zip", 4 * 1024 * 1024, "application/zip")];
    await slowDirectChunks(page, 40);
    const shareLink = await createSession(page, files, { fallback: false });
    const sessionId = new URL(shareLink).pathname.split("/").at(-1);
    const receiver = await newReceiverPage(page, { fallback: false });
    await recordStreamingSinkTrace(receiver);

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(receiver.getByTestId("session-status")).toContainText(
        /Receiving|接收|manifest/i,
        {
          timeout: 20_000,
        },
      );
      await expect
        .poll(
          () =>
            receiver.evaluate((id) => {
              const raw = id ? localStorage.getItem(`p2pfile-active-progress:${id}`) : null;
              if (!raw) return 0;
              const progress = JSON.parse(raw) as { committedBytes?: number };
              return typeof progress.committedBytes === "number" ? progress.committedBytes : 0;
            }, sessionId),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(MANIFEST_CHUNK_BYTES * 2);
      await receiver.reload();
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();

      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      const trace = await readStreamingSinkTrace(receiver);
      if (!trace) throw new Error("Missing streaming sink trace.");
      const readByteLengths = trace.reads.map((read) => read.byteLength);
      expect(readByteLengths.length).toBeGreaterThan(1);
      const maxReadBytes = Math.max(...readByteLengths);
      const fullPrefixReads = trace.reads.filter((read) => read.byteLength > MANIFEST_CHUNK_BYTES);
      expect(maxReadBytes).toBeLessThanOrEqual(MANIFEST_CHUNK_BYTES);
      expect(fullPrefixReads).toEqual([]);
      await writeEvidence("val-rel-012-opfs-resume-read-trace.json", {
        assertionId: "VAL-REL-012",
        workUnitId: "wu-1207294a",
        evidenceSource: "controlled",
        shareLink,
        fileName: files[0].name,
        fileSize: files[0].buffer.byteLength,
        opfsGetDirectoryCalls: trace.opfsGetDirectoryCalls,
        fileHandles: trace.fileHandles,
        reads: trace.reads,
        writes: trace.writes,
        maxReadBytes,
        fullPrefixReads,
      });
    } finally {
      await receiver.close();
    }
  });
});
