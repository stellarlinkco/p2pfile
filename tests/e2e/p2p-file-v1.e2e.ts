import { expect, test } from "@playwright/test";
import {
  accessCodeFrom,
  blockReceiverStorageAndFallbackSignals,
  corruptFirstFallbackChunkDigest,
  countVisible,
  createSession,
  enableTransferFallback,
  makeSizedTestFile,
  newReceiverPage,
  openReceiver,
  qrShareLinkFrom,
  recordTransferEvents,
  slowDirectChunks,
  TEST_FILES,
} from "./p2p-file-v1.support";
import { writeEvidence, writeEvidenceScreenshot } from "./worker-share-link.support";

const MANIFEST_CHUNK_BYTES = 64 * 1024;
test.describe("P2P File v1 session flow", () => {
  test("sender upload surface only advertises available file-picker behavior", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("选择文件", { exact: true })).toBeVisible();
    await expect(page.getByText(/拖拽文件/)).toHaveCount(0);
  });

  test("sender status distinguishes waiting from active transfer", async ({ page }) => {
    await enableTransferFallback(page);
    await page.goto("/");
    await page.getByTestId("sender-file-input").setInputFiles(TEST_FILES);
    await page.getByTestId("create-session-button").click();

    await expect(page.getByText("等待接收方", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("传输中 ●")).toHaveCount(0);
  });

  test("sender receives visible feedback after copying Share Link", async ({ page }) => {
    await enableTransferFallback(page);
    await page.goto("/");
    await page
      .context()
      .grantPermissions(["clipboard-write"], { origin: new URL(page.url()).origin });
    await page.getByTestId("sender-file-input").setInputFiles(TEST_FILES);
    await page.getByTestId("create-session-button").click();

    await page.getByRole("button", { name: "复制链接" }).click();

    await expect(page.getByText("已复制")).toBeVisible();
  });
  test("sender hides share surfaces when runtime startup fails", async ({ page }) => {
    await page.addInitScript(() => {
      class BrokenWebSocket {
        constructor() {
          throw new Error("blocked websocket");
        }
      }

      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        value: BrokenWebSocket,
      });
    });
    await page.goto("/");
    await page.getByTestId("sender-file-input").setInputFiles(TEST_FILES);
    await page.getByTestId("create-session-button").click();

    await expect(page.getByTestId("session-status")).toContainText(/失败|failed/i);
    await expect(page.getByTestId("share-link")).toHaveCount(0);
    await expect(page.getByTestId("qr-code")).toHaveCount(0);
  });

  test("sender creates a multi-file session with frozen manifest and all share surfaces", async ({
    page,
  }) => {
    await createSession(page);
  });

  test("sender Frozen Manifest stays frozen after session creation", async ({ page }) => {
    await createSession(page);

    await page.getByTestId("sender-file-input").setInputFiles({
      name: "replacement.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("replacement", "utf8"),
    });

    const manifest = page.getByTestId("frozen-manifest");
    await expect(manifest).toContainText("notes-alpha.txt");
    await expect(manifest).not.toContainText("replacement.txt");
  });

  test("receiver opens Share Link and sees metadata-only manifest before claim", async ({
    page,
  }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    try {
      await openReceiver(receiver, shareLink);
    } finally {
      await receiver.close();
    }
  });

  test("claim conflict allows exactly one receiver and shows occupied notice to the other", async ({
    page,
  }) => {
    const shareLink = await createSession(page);
    const first = await newReceiverPage(page);
    const second = await newReceiverPage(page);

    try {
      await Promise.all([openReceiver(first, shareLink), openReceiver(second, shareLink)]);
      await Promise.all([
        first.getByTestId("claim-session-button").click(),
        second.getByTestId("claim-session-button").click(),
      ]);

      await expect
        .poll(() => countVisible([first, second], "occupied-session-notice"), {
          message: "exactly one receiver must be rejected as occupied",
        })
        .toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("receiver cannot open another entry while claim is active", async ({ page }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    await receiver.addInitScript(() => {
      const originalPostMessage = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function postMessage(message: unknown) {
        if (typeof this.name === "string" && this.name.startsWith("p2pfile:test:")) {
          return undefined;
        }

        return originalPostMessage.call(this, message);
      };
    });

    try {
      await openReceiver(receiver, shareLink);
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("receiver-open-session-button")).toBeDisabled();
    } finally {
      await receiver.close();
    }
  });

  test("receiver claim continues when token storage is unavailable", async ({ page }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    await blockReceiverStorageAndFallbackSignals(receiver);

    try {
      await openReceiver(receiver, shareLink);
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByRole("button", { name: "放弃接收" })).toBeVisible();
      await expect(receiver.getByTestId("session-status")).not.toContainText(/failed|失败/i);
      await receiver.getByRole("button", { name: "放弃接收" }).click();
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
    } finally {
      await receiver.close();
    }
  });

  test("share-link entry remains horizontally accessible on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createSession(page);

    await expect(page.getByTestId("share-link")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  });

  test("multi-file transfer completes for sender and receiver with mode disclosure", async ({
    page,
  }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    try {
      await openReceiver(receiver, shareLink);
      await receiver.getByTestId("claim-session-button").click();

      await expect(receiver.getByTestId("mode-disclosure")).toContainText(
        /Direct Transfer|Relayed Transfer|直传|中继/i,
      );
      await expect(page.getByTestId("mode-disclosure")).toContainText(
        /Direct Transfer|Relayed Transfer|直传|中继/i,
      );
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(receiver.getByRole("link", { name: "接收其他会话" })).toBeVisible();
      await expect(receiver.getByRole("button", { name: "保存 notes-alpha.txt" })).toBeVisible();
      await expect(receiver.getByRole("button", { name: "保存 notes-beta.json" })).toBeVisible();
    } finally {
      await receiver.close();
    }
  });

  test("multi-file transfer resumes completed active and queued manifest files after interruption", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await recordTransferEvents(page);
    await slowDirectChunks(page, 100);
    const files = [
      makeSizedTestFile("resume-completed-first.txt", MANIFEST_CHUNK_BYTES, "text/plain"),
      makeSizedTestFile("resume-active-large.zip", 2 * 1024 * 1024, "application/zip"),
      makeSizedTestFile("resume-third.bin", MANIFEST_CHUNK_BYTES, "application/octet-stream"),
    ];
    const shareLink = await createSession(page, files, { fallback: false });
    const sessionId = new URL(shareLink).pathname.split("/").at(-1);
    if (!sessionId) throw new Error("share link missing session id");
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);

      const firstCommittedBytes = await page
        .waitForFunction(
          () => {
            const events = (
              window as typeof window & {
                __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
              }
            ).__P2PFILE_TEST_TRANSFER_EVENTS__;
            const commit = events?.find(
              (event) =>
                event.type === "direct-chunk-commit" &&
                event.fileId === "local-2" &&
                Number(event.committedBytes) > 0,
            );
            return commit ? Number(commit.committedBytes) : false;
          },
          undefined,
          { timeout: 30_000 },
        )
        .then((handle) => handle.jsonValue() as Promise<number>);
      await expect
        .poll(
          () =>
            receiver.evaluate((id) => {
              const raw = localStorage.getItem(`p2pfile-active-progress:${id}`);
              if (!raw) return 0;
              const progress = JSON.parse(raw) as { fileId?: string; committedBytes?: number };
              return progress.fileId === "local-2" ? Number(progress.committedBytes) : 0;
            }, sessionId),
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(firstCommittedBytes);
      await page.waitForFunction(
        () => {
          const events = (
            window as typeof window & {
              __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
            }
          ).__P2PFILE_TEST_TRANSFER_EVENTS__;
          return events?.some(
            (event) =>
              (event.type === "direct-file-complete" || event.type === "relay-file-complete") &&
              event.fileId === "local-1",
          );
        },
        undefined,
        { timeout: 30_000 },
      );
      expect(firstCommittedBytes).toBeGreaterThan(0);
      expect(firstCommittedBytes).toBeLessThan(files[1].buffer.byteLength);

      await receiver.reload();
      const resumeOffset = await receiver.evaluate((id) => {
        const raw = localStorage.getItem(`p2pfile-active-progress:${id}`);
        if (!raw) return 0;
        const progress = JSON.parse(raw) as { fileId?: string; committedBytes?: number };
        return progress.fileId === "local-2" ? Number(progress.committedBytes) : 0;
      }, sessionId);
      expect(resumeOffset).toBeGreaterThanOrEqual(firstCommittedBytes);
      expect(resumeOffset).toBeLessThan(files[1].buffer.byteLength);

      await openReceiver(receiver, shareLink, files, { fallback: false });
      await expect(receiver.getByTestId("file-state-local-1")).toContainText("completed");
      await expect(receiver.getByTestId("file-state-local-2")).toContainText("reconnecting");
      await expect(receiver.getByTestId("file-state-local-3")).toContainText("queued");
      await writeEvidence("val-rel-010-local-reconnecting-dom-trace.json", {
        assertionId: "VAL-REL-010",
        workUnitId: "wu-54565d01",
        evidenceSource: "controlled",
        shareLink,
        reconnectingFileStates: {
          "local-1": await receiver.getByTestId("file-state-local-1").textContent(),
          "local-2": await receiver.getByTestId("file-state-local-2").textContent(),
          "local-3": await receiver.getByTestId("file-state-local-3").textContent(),
        },
        resumeOffset,
      });
      await receiver.getByTestId("claim-session-button").click();
      await page.waitForFunction(
        (expectedOffset) => {
          const events = (
            window as typeof window & {
              __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
            }
          ).__P2PFILE_TEST_TRANSFER_EVENTS__;
          return events?.some(
            (event) =>
              (event.type === "direct-file-start" || event.type === "relay-file-start") &&
              event.fileId === "local-2" &&
              Number(event.offset) === expectedOffset,
          );
        },
        resumeOffset,
        { timeout: 30_000 },
      );

      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 60_000 });
      for (const file of files) {
        await expect(receiver.getByRole("button", { name: `保存 ${file.name}` })).toHaveCount(1);
      }

      const transferEvents = await page.evaluate(
        () =>
          ((
            window as typeof window & {
              __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
            }
          ).__P2PFILE_TEST_TRANSFER_EVENTS__ ?? []) as Record<string, unknown>[],
      );
      const fileStarts = transferEvents
        .filter((event) => event.type === "direct-file-start" || event.type === "relay-file-start")
        .map((event) => ({ fileId: event.fileId, offset: Number(event.offset) }));
      expect(fileStarts.filter((event) => event.fileId === "local-1")).toEqual([
        { fileId: "local-1", offset: 0 },
      ]);
      expect(fileStarts).toContainEqual({ fileId: "local-2", offset: 0 });
      expect(fileStarts).toContainEqual({ fileId: "local-2", offset: resumeOffset });
      expect(fileStarts).toContainEqual({ fileId: "local-3", offset: 0 });
      const resumeStartIndex = transferEvents.findIndex(
        (event) =>
          (event.type === "direct-file-start" || event.type === "relay-file-start") &&
          event.fileId === "local-2" &&
          Number(event.offset) === resumeOffset,
      );
      const resentCommittedChunks = transferEvents
        .slice(resumeStartIndex)
        .filter(
          (event) =>
            (event.type === "direct-chunk-commit" || event.type === "relay-chunk-commit") &&
            event.fileId === "local-2" &&
            Number(event.chunkIndex) < Math.floor(resumeOffset / MANIFEST_CHUNK_BYTES),
        );
      expect(resentCommittedChunks).toEqual([]);
    } finally {
      await receiver.close();
    }
  });
  test("bounded per-file states let small files complete before a large file", async ({ page }) => {
    test.setTimeout(120_000);
    await recordTransferEvents(page);
    await slowDirectChunks(page, 80);
    const files = [
      makeSizedTestFile("bounded-large.zip", MANIFEST_CHUNK_BYTES * 12, "application/zip"),
      makeSizedTestFile("bounded-small.txt", MANIFEST_CHUNK_BYTES, "text/plain"),
      makeSizedTestFile("bounded-tail.bin", MANIFEST_CHUNK_BYTES, "application/octet-stream"),
    ];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await expect(receiver.getByTestId("file-state-local-1")).toContainText("queued");
      await expect(receiver.getByTestId("file-state-local-2")).toContainText("queued");
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);

      await expect(receiver.getByTestId("file-state-local-1")).toContainText("receiving", {
        timeout: 30_000,
      });
      await expect(receiver.getByTestId("file-state-local-2")).toContainText("completed", {
        timeout: 30_000,
      });
      await expect(receiver.getByTestId("file-state-local-1")).toContainText("receiving");

      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 90_000 });
      const transferEvents = await page.evaluate(
        () =>
          ((
            window as typeof window & {
              __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
            }
          ).__P2PFILE_TEST_TRANSFER_EVENTS__ ?? []) as Record<string, unknown>[],
      );
      const largeCompleteIndex = transferEvents.findIndex(
        (event) => event.type === "direct-file-complete" && event.fileId === "local-1",
      );
      const smallCompleteIndex = transferEvents.findIndex(
        (event) => event.type === "direct-file-complete" && event.fileId === "local-2",
      );
      expect(smallCompleteIndex).toBeGreaterThanOrEqual(0);
      expect(largeCompleteIndex).toBeGreaterThan(smallCompleteIndex);
      for (const file of files) {
        await expect(receiver.getByRole("button", { name: `保存 ${file.name}` })).toHaveCount(1);
      }
    } finally {
      await receiver.close();
    }
  });

  test("per-file states show failed when a fallback transfer chunk is rejected", async ({
    page,
  }) => {
    await corruptFirstFallbackChunkDigest(page);
    const files = [
      makeSizedTestFile("failed-large.zip", MANIFEST_CHUNK_BYTES * 2, "application/zip"),
      makeSizedTestFile("failed-tail.bin", MANIFEST_CHUNK_BYTES, "application/octet-stream"),
    ];
    const shareLink = await createSession(page, files);
    const receiver = await newReceiverPage(page);

    try {
      await openReceiver(receiver, shareLink, files);
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("file-state-local-1")).toContainText("failed", {
        timeout: 30_000,
      });
      await expect(receiver.getByTestId("file-state-local-2")).toContainText("failed");
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
      await expect(receiver.getByText(/Chunk integrity verification failed/)).toBeVisible();
      const screenshotPath = await writeEvidenceScreenshot(
        receiver,
        "val-rel-010-failed-states.png",
      );
      await writeEvidence("val-rel-010-local-failed-dom-trace.json", {
        assertionId: "VAL-REL-010",
        workUnitId: "wu-54565d01",
        evidenceSource: "controlled",
        shareLink,
        failedFileStates: {
          "local-1": await receiver.getByTestId("file-state-local-1").textContent(),
          "local-2": await receiver.getByTestId("file-state-local-2").textContent(),
        },
        screenshotPath,
      });
    } finally {
      await receiver.close();
    }
  });
  test("receiver can open the same session through Access Code entry", async ({ page }) => {
    const shareLink = await createSession(page);
    const sessionId = new URL(shareLink).pathname.split("/").pop();
    if (!sessionId) {
      throw new Error("share link missing session id");
    }

    const accessCode = await accessCodeFrom(page);
    const receiver = await newReceiverPage(page);

    try {
      await receiver.goto("/receive");
      await receiver.getByTestId("receiver-entry-input").fill(accessCode);
      await receiver.getByTestId("receiver-open-session-button").click();
      await expect(receiver).toHaveURL(new RegExp(`/f/${sessionId}$`));
      await expect(receiver.getByTestId("receiver-manifest")).toBeVisible();
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
    } finally {
      await receiver.close();
    }
  });

  test("QR Code encodes a share link that opens the same session", async ({ page }) => {
    const shareLink = await createSession(page);
    const qrShareLink = await qrShareLinkFrom(page);
    const receiver = await newReceiverPage(page);

    expect(qrShareLink).toBe(shareLink);

    try {
      await openReceiver(receiver, qrShareLink);
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
    } finally {
      await receiver.close();
    }
  });

  test("direct transfer completes without the test fallback runtime", async ({ page }) => {
    const shareLink = await createSession(page, TEST_FILES, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, TEST_FILES, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();

      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(page.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await receiver.close();
    }
  });

  test("sender exit ends the receiver session", async ({ page }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    try {
      await openReceiver(receiver, shareLink);
      await page.getByRole("button", { name: "结束会话" }).click();
      await expect(receiver.getByTestId("ended-session-notice")).toBeVisible({
        timeout: 15_000,
      });
      await expect(receiver.getByTestId("ended-session-notice")).toContainText(
        /发送方|sender|结束|ended|重新创建/i,
      );
    } finally {
      await receiver.close();
    }
  });
});
