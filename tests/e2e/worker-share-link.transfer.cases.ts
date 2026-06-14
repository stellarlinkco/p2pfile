import { expect, test } from "@playwright/test";
import {
  createSession,
  forceDirectFail,
  makeSizedTestFile,
  openReceiver,
  recordTransferEvents,
  slowDirectChunks,
  TEST_FILES,
  waitForCompletedSession,
} from "./p2p-file-v1.support";
import {
  observeApiRequests,
  observeWebSockets,
  writeEvidence,
  writeEvidenceScreenshot,
} from "./worker-share-link.support";

const MANIFEST_CHUNK_BYTES = 64 * 1024;

test("Worker Direct Transfer completes a small file through SessionObject WebSockets", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);

  const files = [TEST_FILES[0]];
  const shareLink = await createSession(page, files, { fallback: false });
  const senderOrigin = new URL(page.url()).origin;
  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);

  try {
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();

    await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer/i, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("mode-disclosure")).toContainText(/Direct Transfer/i, {
      timeout: 30_000,
    });
    await expect(receiver.getByTestId("mode-disclosure")).not.toContainText(/Relayed Transfer/i);
    await expect(page.getByTestId("mode-disclosure")).not.toContainText(/Relayed Transfer/i);
    await expect(
      receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(receiver.getByRole("button", { name: `保存 ${files[0].name}` })).toBeVisible();

    expect(websocketRequests).toHaveLength(2);
    for (const url of websocketRequests) {
      expect(new URL(url).origin).toBe(senderOrigin.replace(/^http/, "ws"));
      expect(url).toContain("/ws/");
    }

    await writeEvidence("worker-direct-transfer-dom-trace.json", {
      assertionId: "VAL-CF-005",
      shareLink,
      senderOrigin,
      receiverUrl: receiver.url(),
      apiRequests,
      websocketRequests,
      senderModeDisclosure: await page.getByTestId("mode-disclosure").textContent(),
      receiverModeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
      receiverCompletedVisible: await receiver
        .getByRole("heading", { level: 3, name: "Completed Session View" })
        .count(),
      senderCompletedVisible: await page
        .getByRole("heading", { level: 3, name: "Completed Session View" })
        .count(),
      saveButtonVisible: await receiver
        .getByRole("button", { name: `保存 ${files[0].name}` })
        .count(),
    });
  } finally {
    await receiver.close();
  }
});

test("Worker completed sessions reopen only for original receiver", async ({ page, browser }) => {
  test.setTimeout(60_000);
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);

  const files = [TEST_FILES[0]];
  const shareLink = await createSession(page, files, { fallback: false });
  const senderOrigin = new URL(page.url()).origin;
  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);

  const nonOwnerContext = await browser.newContext();
  try {
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();
    await waitForCompletedSession(receiver);
    await waitForCompletedSession(page);

    await receiver.reload();
    await waitForCompletedSession(receiver);
    await expect(receiver.getByTestId("completion-notice")).toHaveCount(0);

    const nonOwner = await nonOwnerContext.newPage();
    observeApiRequests(nonOwner, apiRequests);
    await nonOwner.goto(shareLink);
    await expect(nonOwner.getByTestId("completion-notice")).toBeVisible({ timeout: 15_000 });
    await expect(nonOwner.getByTestId("completed-session-view")).toHaveCount(0);
    await expect(nonOwner.getByTestId("claim-session-button")).toHaveCount(0);
    await expect(nonOwner.getByRole("button", { name: `保存 ${files[0].name}` })).toHaveCount(0);

    await writeEvidence("worker-completed-session-access-dom-trace.json", {
      assertionId: "VAL-CF-008",
      workUnitId: "wu-956dd05d",
      evidenceSource: "controlled",
      shareLink,
      senderOrigin,
      originalReceiverUrl: receiver.url(),
      nonOwnerUrl: nonOwner.url(),
      apiRequests,
      websocketRequests: websocketRequests.filter((url) => url.includes("/ws/")),
      originalReceiverCompletedVisible: await receiver
        .getByTestId("completed-session-view")
        .count(),
      nonOwnerCompletionNoticeVisible: await nonOwner.getByTestId("completion-notice").count(),
      nonOwnerCompletedViewVisible: await nonOwner.getByTestId("completed-session-view").count(),
      nonOwnerClaimButtonVisible: await nonOwner.getByTestId("claim-session-button").count(),
      nonOwnerSaveButtonVisible: await nonOwner
        .getByRole("button", { name: `保存 ${files[0].name}` })
        .count(),
    });
  } finally {
    await receiver.close();
    await nonOwnerContext.close();
  }
});

test("Worker forced direct failure falls back to Relayed Transfer over WebSockets", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);

  const files = [TEST_FILES[0]];
  const shareLink = await createSession(page, files, { fallback: false });
  const senderOrigin = new URL(page.url()).origin;
  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);
  await forceDirectFail(receiver);

  try {
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();

    await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer/i, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer/i, {
      timeout: 30_000,
    });
    await expect(
      receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 30_000 });

    const signalWebSocketRequests = websocketRequests.filter((url) => url.includes("/ws/"));
    expect(signalWebSocketRequests).toHaveLength(2);
    for (const url of signalWebSocketRequests) {
      expect(url).toContain("/ws/");
    }

    await writeEvidence("worker-forced-relay-dom-trace.json", {
      assertionId: "VAL-CF-006",
      workUnitId: "wu-707644fd",
      shareLink,
      senderOrigin,
      receiverUrl: receiver.url(),
      apiRequests,
      websocketRequests: signalWebSocketRequests,
      senderModeDisclosure: await page.getByTestId("mode-disclosure").textContent(),
      receiverModeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
      receiverCompletedVisible: await receiver
        .getByRole("heading", { level: 3, name: "Completed Session View" })
        .count(),
      senderCompletedVisible: await page
        .getByRole("heading", { level: 3, name: "Completed Session View" })
        .count(),
    });
  } finally {
    await receiver.close();
  }
});

test("Worker Relayed Transfer completes a large zip file over WebSockets", async ({ page }) => {
  test.setTimeout(90_000);
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);

  const files = [makeSizedTestFile("large-worker-relay.zip", 1024 * 1024, "application/zip")];
  const shareLink = await createSession(page, files, { fallback: false });
  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);
  await forceDirectFail(receiver);

  try {
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();

    await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer/i, {
      timeout: 45_000,
    });
    await expect(
      receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      receiver.getByRole("button", { name: "保存 large-worker-relay.zip" }),
    ).toBeVisible();

    const signalWebSocketRequests = websocketRequests.filter((url) => url.includes("/ws/"));
    expect(signalWebSocketRequests).toHaveLength(2);
    await writeEvidence("worker-large-relay-dom-trace.json", {
      assertionId: "VAL-CF-006-LARGE",
      shareLink,
      apiRequests,
      websocketRequests: signalWebSocketRequests,
      receiverModeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
    });
  } finally {
    await receiver.close();
  }
});

test("Worker Relayed Transfer resumes a large zip mid-file after receiver reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);
  await recordTransferEvents(page);
  await slowDirectChunks(page, 500);

  const files = [
    makeSizedTestFile("mid-file-worker-relay.zip", 1024 * 1024 + 1, "application/zip"),
  ];
  const shareLink = await createSession(page, files, { fallback: false });
  let receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);
  await forceDirectFail(receiver);

  try {
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();

    await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer/i, {
      timeout: 45_000,
    });

    const committedBytes = await page
      .waitForFunction(
        () => {
          const events = (
            window as typeof window & {
              __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
            }
          ).__P2PFILE_TEST_TRANSFER_EVENTS__;
          const commit = events?.find(
            (event) => event.type === "relay-chunk-commit" && Number(event.committedBytes) > 0,
          );
          return commit ? Number(commit.committedBytes) : false;
        },
        undefined,
        { timeout: 45_000 },
      )
      .then((handle) => handle.jsonValue() as Promise<number>);
    expect(committedBytes).toBeGreaterThan(0);
    expect(committedBytes).toBeLessThan(files[0].buffer.byteLength);

    await receiver.close();
    receiver = await page.context().newPage();
    observeApiRequests(receiver, apiRequests);
    observeWebSockets(receiver, websocketRequests);
    await forceDirectFail(receiver);
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();

    await page.waitForFunction(
      (expectedOffset) => {
        const events = (
          window as typeof window & {
            __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
          }
        ).__P2PFILE_TEST_TRANSFER_EVENTS__;
        return events?.some(
          (event) => event.type === "relay-file-start" && Number(event.offset) === expectedOffset,
        );
      },
      committedBytes,
      { timeout: 45_000 },
    );
    await expect(
      receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      page.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      receiver.getByRole("button", { name: "保存 mid-file-worker-relay.zip" }),
    ).toBeVisible();

    const transferEvents = await page.evaluate(
      () =>
        ((
          window as typeof window & {
            __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
          }
        ).__P2PFILE_TEST_TRANSFER_EVENTS__ ?? []) as Record<string, unknown>[],
    );
    const relayFileStartOffsets = transferEvents
      .filter((event) => event.type === "relay-file-start")
      .map((event) => Number(event.offset));
    expect(relayFileStartOffsets).toContain(0);
    expect(relayFileStartOffsets).toContain(committedBytes);

    const signalWebSocketRequests = websocketRequests.filter((url) => url.includes("/ws/"));
    expect(signalWebSocketRequests.length).toBeGreaterThanOrEqual(3);
    await writeEvidence("worker-relay-mid-file-resume-dom-trace.json", {
      assertionId: "VAL-REL-006",
      workUnitId: "wu-d9b37889",
      shareLink,
      apiRequests,
      websocketRequests: signalWebSocketRequests,
      committedBytesBeforeReload: committedBytes,
      relayFileStartOffsets,
      transferEvents,
      receiverModeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
      receiverCompletedVisible: await receiver.getByTestId("completed-session-view").count(),
      senderCompletedVisible: await page.getByTestId("completed-session-view").count(),
    });
  } finally {
    await receiver.close();
  }
});

test("Worker Relayed Transfer resumes multi-file manifest without re-sending completed or committed chunks", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);
  await recordTransferEvents(page);
  await slowDirectChunks(page, 500);

  const files = [
    makeSizedTestFile("worker-resume-completed-first.txt", MANIFEST_CHUNK_BYTES, "text/plain"),
    makeSizedTestFile(
      "worker-resume-active-large.zip",
      1024 * 1024 + MANIFEST_CHUNK_BYTES,
      "application/zip",
    ),
    makeSizedTestFile("worker-resume-third.bin", MANIFEST_CHUNK_BYTES, "application/octet-stream"),
  ];
  const shareLink = await createSession(page, files, { fallback: false });
  const sessionId = new URL(shareLink).pathname.split("/").at(-1);
  if (!sessionId) throw new Error("share link missing session id");
  let receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);
  await forceDirectFail(receiver);

  try {
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();
    await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer/i, {
      timeout: 45_000,
    });

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
              event.type === "relay-chunk-commit" &&
              event.fileId === "local-2" &&
              Number(event.committedBytes) > 0,
          );
          return commit ? Number(commit.committedBytes) : false;
        },
        undefined,
        { timeout: 45_000 },
      )
      .then((handle) => handle.jsonValue() as Promise<number>);
    expect(firstCommittedBytes).toBeGreaterThan(0);
    expect(firstCommittedBytes).toBeLessThan(files[1].buffer.byteLength);
    const resumeOffset = await receiver.evaluate((id) => {
      const raw = localStorage.getItem(`p2pfile-active-progress:${id}`);
      if (!raw) return 0;
      const progress = JSON.parse(raw) as { fileId?: string; committedBytes?: number };
      return progress.fileId === "local-2" ? Number(progress.committedBytes) : 0;
    }, sessionId);
    await page.waitForFunction(
      () => {
        const events = (
          window as typeof window & {
            __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
          }
        ).__P2PFILE_TEST_TRANSFER_EVENTS__;
        return events?.some(
          (event) => event.type === "relay-file-complete" && event.fileId === "local-1",
        );
      },
      undefined,
      { timeout: 45_000 },
    );
    expect(resumeOffset).toBeGreaterThanOrEqual(firstCommittedBytes);
    expect(resumeOffset).toBeLessThan(files[1].buffer.byteLength);

    await receiver.close();
    receiver = await page.context().newPage();
    observeApiRequests(receiver, apiRequests);
    observeWebSockets(receiver, websocketRequests);
    await forceDirectFail(receiver);
    await openReceiver(receiver, shareLink, files, { fallback: false });
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
            event.type === "relay-file-start" &&
            event.fileId === "local-2" &&
            Number(event.offset) === expectedOffset,
        );
      },
      resumeOffset,
      { timeout: 45_000 },
    );
    await expect(
      receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      page.getByRole("heading", { level: 3, name: "Completed Session View" }),
    ).toBeVisible({ timeout: 90_000 });
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
    const relayFileStarts = transferEvents
      .filter((event) => event.type === "relay-file-start")
      .map((event) => ({ fileId: event.fileId, offset: Number(event.offset) }));
    expect(relayFileStarts.filter((event) => event.fileId === "local-1")).toEqual([
      { fileId: "local-1", offset: 0 },
    ]);
    expect(relayFileStarts).toContainEqual({ fileId: "local-2", offset: 0 });
    expect(relayFileStarts).toContainEqual({ fileId: "local-2", offset: resumeOffset });
    expect(relayFileStarts).toContainEqual({ fileId: "local-3", offset: 0 });
    const resumeStartIndex = transferEvents.findIndex(
      (event) =>
        event.type === "relay-file-start" &&
        event.fileId === "local-2" &&
        Number(event.offset) === resumeOffset,
    );
    const resentCommittedChunks = transferEvents
      .slice(resumeStartIndex)
      .filter(
        (event) =>
          event.type === "relay-chunk-commit" &&
          event.fileId === "local-2" &&
          Number(event.chunkIndex) < Math.floor(resumeOffset / MANIFEST_CHUNK_BYTES),
      );
    expect(resentCommittedChunks).toEqual([]);

    const screenshotPath = await writeEvidenceScreenshot(receiver, "val-rel-008-resume.png");
    const signalWebSocketRequests = websocketRequests.filter((url) => url.includes("/ws/"));
    expect(signalWebSocketRequests.length).toBeGreaterThanOrEqual(3);
    await writeEvidence("worker-multi-file-resume-dom-trace.json", {
      assertionId: "VAL-REL-008",
      workUnitId: "wu-b317eefb",
      evidenceSource: "controlled",
      shareLink,
      apiRequests,
      websocketRequests: signalWebSocketRequests,
      committedBytesBeforeReload: firstCommittedBytes,
      resumeOffset,
      relayFileStarts,
      transferEvents,
      receiverModeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
      receiverCompletedVisible: await receiver.getByTestId("completed-session-view").count(),
      senderCompletedVisible: await page.getByTestId("completed-session-view").count(),
      saveButtonsVisible: Object.fromEntries(
        await Promise.all(
          files.map(async (file) => [
            file.name,
            await receiver.getByRole("button", { name: `保存 ${file.name}` }).count(),
          ]),
        ),
      ),
      screenshotPath,
    });
  } finally {
    await receiver.close();
  }
});

test("Worker bounded per-file states let small files complete before a large file over Relayed Transfer", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);
  await recordTransferEvents(page);
  await slowDirectChunks(page, 100);

  const files = [
    makeSizedTestFile("worker-bounded-large.zip", MANIFEST_CHUNK_BYTES * 12, "application/zip"),
    makeSizedTestFile("worker-bounded-small.txt", MANIFEST_CHUNK_BYTES, "text/plain"),
    makeSizedTestFile("worker-bounded-tail.bin", MANIFEST_CHUNK_BYTES, "application/octet-stream"),
  ];
  const shareLink = await createSession(page, files, { fallback: false });
  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);
  await forceDirectFail(receiver);

  try {
    await openReceiver(receiver, shareLink, files, { fallback: false });
    await expect(receiver.getByTestId("file-state-local-1")).toContainText("queued");
    await expect(receiver.getByTestId("file-state-local-2")).toContainText("queued");
    await receiver.getByTestId("claim-session-button").click();
    await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer/i, {
      timeout: 45_000,
    });
    await expect(receiver.getByTestId("file-state-local-1")).toContainText("receiving", {
      timeout: 45_000,
    });
    await expect(receiver.getByTestId("file-state-local-2")).toContainText("completed", {
      timeout: 45_000,
    });
    await expect(receiver.getByTestId("file-state-local-1")).toContainText("receiving");

    await expect(receiver.getByTestId("completed-session-view")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("completed-session-view")).toBeVisible({ timeout: 90_000 });
    const transferEvents = await page.evaluate(
      () =>
        ((
          window as typeof window & {
            __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
          }
        ).__P2PFILE_TEST_TRANSFER_EVENTS__ ?? []) as Record<string, unknown>[],
    );
    const largeCompleteIndex = transferEvents.findIndex(
      (event) => event.type === "relay-file-complete" && event.fileId === "local-1",
    );
    const smallCompleteIndex = transferEvents.findIndex(
      (event) => event.type === "relay-file-complete" && event.fileId === "local-2",
    );
    expect(smallCompleteIndex).toBeGreaterThanOrEqual(0);
    expect(largeCompleteIndex).toBeGreaterThan(smallCompleteIndex);
    for (const file of files) {
      await expect(receiver.getByRole("button", { name: `保存 ${file.name}` })).toHaveCount(1);
      await expect(
        receiver.getByTestId(`file-state-local-${files.indexOf(file) + 1}`),
      ).toContainText("completed");
    }

    const screenshotPath = await writeEvidenceScreenshot(receiver, "val-rel-010-bounded.png");
    const signalWebSocketRequests = websocketRequests.filter((url) => url.includes("/ws/"));
    expect(signalWebSocketRequests).toHaveLength(2);
    await writeEvidence("val-rel-010-bounded-dom-trace.json", {
      assertionId: "VAL-REL-010",
      workUnitId: "wu-54565d01",
      evidenceSource: "controlled",
      shareLink,
      apiRequests,
      websocketRequests: signalWebSocketRequests,
      smallCompleteIndex,
      largeCompleteIndex,
      transferEvents,
      finalFileStates: Object.fromEntries(
        await Promise.all(
          files.map(async (_file, index) => [
            `local-${index + 1}`,
            await receiver.getByTestId(`file-state-local-${index + 1}`).textContent(),
          ]),
        ),
      ),
      receiverCompletedVisible: await receiver.getByTestId("completed-session-view").count(),
      senderCompletedVisible: await page.getByTestId("completed-session-view").count(),
      screenshotPath,
    });
  } finally {
    await receiver.close();
  }
});
