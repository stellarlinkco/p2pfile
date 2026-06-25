import { expect, test } from "@playwright/test";
import {
  createSession,
  forceDirectFail,
  makeSizedTestFile,
  newReceiverPage,
  openReceiver,
  slowDirectChunks,
} from "./p2p-file-v1.support";
import {
  applyNetworkDegradation,
  clearNetworkDegradation,
  disableOpfsOnPage,
  failOpfsWritesOnPage,
  installSenderSocketControl,
  observeConsoleErrors,
} from "./transfer-stability.support";
import {
  observeApiRequests,
  observeWebSockets,
  writeEvidence,
  writeEvidenceScreenshot,
} from "./worker-share-link.support";

const MANIFEST_CHUNK_BYTES = 64 * 1024;

test.describe("transfer stability coverage", () => {
  test("active Direct Transfer survives sender signaling reconnect during a large transfer", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const consoleErrors: string[] = [];
    const apiRequests: string[] = [];
    const websocketRequests: string[] = [];
    observeConsoleErrors(page, consoleErrors);
    observeApiRequests(page, apiRequests);
    observeWebSockets(page, websocketRequests);
    await installSenderSocketControl(page);
    await slowDirectChunks(page, 35);

    const files = [
      makeSizedTestFile("signal-reconnect-large.zip", 3 * 1024 * 1024, "application/zip"),
    ];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });
    observeConsoleErrors(receiver, consoleErrors);
    observeApiRequests(receiver, apiRequests);
    observeWebSockets(receiver, websocketRequests);

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(receiver.getByTestId("session-status")).toContainText(
        /Receiving|接收|Transfer/i,
        {
          timeout: 25_000,
        },
      );
      await expect
        .poll(
          () =>
            receiver.evaluate(() => {
              const status =
                document.querySelector('[data-testid="session-status"]')?.textContent ?? "";
              return /Receiving|接收|Transfer/i.test(status);
            }),
          { timeout: 25_000 },
        )
        .toBe(true);

      await page.evaluate(() =>
        (
          window as unknown as { __P2PFILE_CLOSE_SENDER_SIGNAL__: () => void }
        ).__P2PFILE_CLOSE_SENDER_SIGNAL__(),
      );

      await expect(receiver.getByTestId("ended-session-notice")).toHaveCount(0);
      await expect(receiver.getByTestId("completed-session-view")).toHaveCount(0);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 90_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 90_000 });

      const screenshotPath = await writeEvidenceScreenshot(
        receiver,
        "val-stab-001-signal-reconnect.png",
      );
      await writeEvidence("val-stab-001-signal-reconnect-dom-trace.json", {
        assertionId: "VAL-STAB-001",
        evidenceSource: "controlled",
        shareLink,
        modeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
        receiverStatus: await receiver.getByTestId("session-status").textContent(),
        endedNoticeCount: await receiver.getByTestId("ended-session-notice").count(),
        completedViewCount: await receiver.getByTestId("completed-session-view").count(),
        consoleErrors,
        apiRequests,
        websocketRequests: websocketRequests.filter((url) => url.includes("/ws/")),
        screenshotPath,
      });
    } finally {
      await receiver.close();
    }
  });

  test("network-degraded Direct Transfer and Relayed Transfer disclose mode and reach a terminal state", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const consoleErrors: string[] = [];
    observeConsoleErrors(page, consoleErrors);

    const directFiles = [makeSizedTestFile("degraded-direct.zip", 128 * 1024, "application/zip")];
    await slowDirectChunks(page, 5);
    const directShareLink = await createSession(page, directFiles, { fallback: false });
    const directReceiver = await newReceiverPage(page, { fallback: false });
    observeConsoleErrors(directReceiver, consoleErrors);
    const directCdp = await applyNetworkDegradation(directReceiver, {
      latencyMs: 80,
      downloadKbps: 1600,
      uploadKbps: 1600,
    });
    await applyNetworkDegradation(page, { latencyMs: 80, downloadKbps: 1600, uploadKbps: 1600 });

    let directMode: string | null = null;
    try {
      await openReceiver(directReceiver, directShareLink, directFiles, { fallback: false });
      await directReceiver.getByTestId("claim-session-button").click();
      await expect(directReceiver.getByTestId("mode-disclosure")).toContainText(
        /Direct Transfer|直传/i,
      );
      await expect
        .poll(
          async () =>
            (await directReceiver.getByTestId("completed-session-view").count()) +
            (await directReceiver.getByTestId("ended-session-notice").count()),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(0);
      directMode = await directReceiver.getByTestId("mode-disclosure").textContent();
    } finally {
      await clearNetworkDegradation(directCdp);
      await directReceiver.close();
    }

    const relayFiles = [makeSizedTestFile("degraded-relay.zip", 64 * 1024, "application/zip")];
    const relayShareLink = await createSession(page, relayFiles, { fallback: false });
    const relayReceiver = await newReceiverPage(page, { fallback: false });
    observeConsoleErrors(relayReceiver, consoleErrors);
    await forceDirectFail(relayReceiver);
    const relayCdp = await applyNetworkDegradation(relayReceiver, {
      latencyMs: 80,
    });
    await applyNetworkDegradation(page, { latencyMs: 80 });

    try {
      await openReceiver(relayReceiver, relayShareLink, relayFiles, { fallback: false });
      await relayReceiver.getByTestId("claim-session-button").click();
      await expect(relayReceiver.getByTestId("mode-disclosure")).toContainText(
        /Relayed Transfer|中继/i,
      );
      await expect(
        relayReceiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 120_000 });

      await writeEvidence("val-stab-002-network-degradation-dom-trace.json", {
        assertionId: "VAL-STAB-002",
        evidenceSource: "controlled",
        directShareLink,
        relayShareLink,
        directMode,
        relayMode: await relayReceiver.getByTestId("mode-disclosure").textContent(),
        relayStatus: await relayReceiver.getByTestId("session-status").textContent(),
        consoleErrors,
        note: "Direct path uses latency plus throughput caps; relay path uses latency-only degradation because WebSocket relay is already slower.",
      });
    } finally {
      await clearNetworkDegradation(relayCdp);
      await relayReceiver.close();
    }
  });

  test("sender page close during active transfer shows Sender-Ended Session guidance", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await slowDirectChunks(page, 30);
    const files = [makeSizedTestFile("sender-close.zip", 2 * 1024 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(receiver.getByTestId("session-status")).toContainText(
        /Receiving|接收|Transfer/i,
        {
          timeout: 20_000,
        },
      );

      await page.close();

      await expect(receiver.getByTestId("ended-session-notice")).toBeVisible({ timeout: 20_000 });
      await expect(receiver.getByTestId("ended-session-notice")).toContainText(
        /Sender-Ended Session|发送方|重新创建/i,
      );
      await expect(receiver.getByTestId("completed-session-view")).toHaveCount(0);
      await expect(receiver.getByRole("button", { name: `保存 ${files[0].name}` })).toHaveCount(0);

      await writeEvidence("val-stab-003-sender-close-dom-trace.json", {
        assertionId: "VAL-STAB-003",
        evidenceSource: "controlled",
        shareLink,
        endedNotice: await receiver.getByTestId("ended-session-notice").textContent(),
        completedViewCount: await receiver.getByTestId("completed-session-view").count(),
      });
    } finally {
      await receiver.close();
    }
  });

  test("sender reload during active transfer shows Sender-Ended Session guidance", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await slowDirectChunks(page, 30);
    const files = [makeSizedTestFile("sender-reload.zip", 2 * 1024 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("session-status")).toContainText(
        /Receiving|接收|Transfer/i,
        {
          timeout: 20_000,
        },
      );

      await page.reload();

      await expect(receiver.getByTestId("ended-session-notice")).toBeVisible({ timeout: 20_000 });
      await expect(receiver.getByTestId("completed-session-view")).toHaveCount(0);
    } finally {
      await receiver.close();
    }
  });

  test("OPFS unavailable for a large file does not create a false Completed Session", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const files = [makeSizedTestFile("opfs-unavailable.zip", 2 * 1024 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });
    await disableOpfsOnPage(receiver);

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(
        receiver.getByText(/Large-file receiver storage unavailable|receiver storage unavailable/i),
      ).toBeVisible({ timeout: 30_000 });
      await expect(receiver.getByTestId("completed-session-view")).toHaveCount(0);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toHaveCount(0);
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();

      await writeEvidence("val-stab-004-opfs-unavailable-dom-trace.json", {
        assertionId: "VAL-STAB-004",
        evidenceSource: "controlled",
        shareLink,
        receiverStatus: await receiver.getByTestId("session-status").textContent(),
        receiverError: await receiver
          .locator("p.text-rose-700")
          .textContent()
          .catch(() => null),
        completedViewCount: await receiver.getByTestId("completed-session-view").count(),
      });
    } finally {
      await receiver.close();
    }
  });

  test("OPFS write failure for a large file keeps retry guidance instead of false completion", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await slowDirectChunks(page, 15);
    const files = [makeSizedTestFile("opfs-write-fail.zip", 2 * 1024 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });
    await failOpfsWritesOnPage(receiver);

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByText(/OPFS write quota exceeded|quota exceeded/i)).toBeVisible({
        timeout: 45_000,
      });
      await expect(receiver.getByTestId("completed-session-view")).toHaveCount(0);
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
      await expect(receiver.getByTestId("retry-budget-remaining")).toContainText(/\d/);
    } finally {
      await receiver.close();
    }
  });

  test("browser capability baseline keeps environment-dependent transfer disclosure on Chromium", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Current stability matrix baseline runs on Desktop Chromium.",
    );
    const files = [
      makeSizedTestFile("browser-matrix.zip", MANIFEST_CHUNK_BYTES * 2, "application/zip"),
    ];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 45_000 });

      await writeEvidence("val-stab-008-browser-matrix-dom-trace.json", {
        assertionId: "VAL-STAB-008",
        evidenceSource: "controlled",
        browserName,
        shareLink,
        modeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
      });
    } finally {
      await receiver.close();
    }
  });
});
