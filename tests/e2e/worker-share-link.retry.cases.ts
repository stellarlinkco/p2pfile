import { expect, test } from "@playwright/test";
import {
  createSession,
  newReceiverPage,
  pauseFallbackAfterFiles,
  waitForCompletedSession,
} from "./p2p-file-v1.support";
import {
  installSenderSocketControl,
  observeApiRequests,
  observeWebSockets,
  VAL_CF_007_FILES,
  VAL_REL_002_FILES,
  writeEvidence,
  writeEvidenceScreenshot,
} from "./worker-share-link.support";

test("Worker interrupted receiver retry retains completed files and restarts at boundary", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);
  await pauseFallbackAfterFiles(page, 1);

  const shareLink = await createSession(page, VAL_CF_007_FILES);
  const senderOrigin = new URL(page.url()).origin;
  const receiver = await newReceiverPage(page);
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);

  try {
    await receiver.goto(shareLink);
    await expect(receiver.getByTestId("receiver-manifest")).toContainText(
      "retry-retained-first.txt",
    );
    await expect(receiver.getByTestId("receiver-manifest")).toContainText(
      "retry-unfinished-second.bin",
    );
    await receiver.getByTestId("claim-session-button").click();
    await expect(receiver.getByText("1 / 2", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await receiver.reload();

    await expect(receiver.getByTestId("retry-budget-remaining")).toContainText("2");
    const retryBudgetText = await receiver.getByTestId("retry-budget-remaining").textContent();
    await receiver.getByTestId("claim-session-button").click();

    await waitForCompletedSession(receiver);
    await waitForCompletedSession(page);
    await expect(
      receiver.getByRole("button", { name: "保存 retry-retained-first.txt" }),
    ).toHaveCount(1);
    await expect(
      receiver.getByRole("button", { name: "保存 retry-unfinished-second.bin" }),
    ).toHaveCount(1);

    await writeEvidence("worker-interrupted-receiver-retry-dom-trace.json", {
      assertionId: "VAL-CF-007",
      workUnitId: "wu-06ea6fc6",
      evidenceSource: "controlled",
      shareLink,
      senderOrigin,
      receiverUrl: receiver.url(),
      apiRequests,
      websocketRequests: websocketRequests.filter((url) => url.includes("/ws/")),
      retryBudgetText,
      retainedFirstSaveVisible: await receiver
        .getByRole("button", { name: "保存 retry-retained-first.txt" })
        .count(),
      restartedSecondSaveVisible: await receiver
        .getByRole("button", { name: "保存 retry-unfinished-second.bin" })
        .count(),
      receiverCompletedVisible: await receiver.getByTestId("completed-session-view").count(),
      senderCompletedVisible: await page.getByTestId("completed-session-view").count(),
    });
  } finally {
    await receiver.close();
  }
});

test("Worker sender interruption lets receiver reuse same Share Link at file boundary", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);
  await installSenderSocketControl(page);
  await pauseFallbackAfterFiles(page, 1);

  const shareLink = await createSession(page, VAL_REL_002_FILES, { fallback: false });
  const receiver = await newReceiverPage(page, { fallback: false });
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);

  try {
    await receiver.goto(shareLink);
    await expect(receiver.getByTestId("receiver-manifest")).toContainText(
      "reconnect-retained-first.txt",
    );
    await receiver.getByTestId("claim-session-button").click();
    await expect(receiver.getByText("1 / 2", { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() =>
      (
        window as unknown as { __P2PFILE_CLOSE_SENDER_SIGNAL__: () => void }
      ).__P2PFILE_CLOSE_SENDER_SIGNAL__(),
    );
    await expect(receiver.getByTestId("reconnecting-session-notice")).toBeVisible({
      timeout: 15_000,
    });

    await receiver.reload();
    await expect(receiver).toHaveURL(shareLink);
    await expect(receiver.getByTestId("retry-budget-remaining")).toContainText("2");
    await receiver.getByTestId("claim-session-button").click();
    await waitForCompletedSession(receiver);
    await waitForCompletedSession(page);
    await expect(
      receiver.getByRole("button", { name: "保存 reconnect-retained-first.txt" }),
    ).toHaveCount(1);
    await expect(
      receiver.getByRole("button", { name: "保存 reconnect-restarted-second.bin" }),
    ).toHaveCount(1);

    const screenshotPath = await writeEvidenceScreenshot(receiver, "val-rel-002-resume.png");
    await writeEvidence("val-rel-002-dom-trace.json", {
      assertionId: "VAL-REL-002",
      workUnitId: "wu-fba92724",
      evidenceSource: "controlled",
      shareLink,
      finalUrl: receiver.url(),
      apiRequests,
      websocketRequests: websocketRequests.filter((url) => url.includes("/ws/")),
      receiverStatus: await receiver.getByTestId("session-status").textContent(),
      completedVisible: await receiver.getByTestId("completed-session-view").count(),
      retainedFirstSaveVisible: await receiver
        .getByRole("button", { name: "保存 reconnect-retained-first.txt" })
        .count(),
      restartedSecondSaveVisible: await receiver
        .getByRole("button", { name: "保存 reconnect-restarted-second.bin" })
        .count(),
      screenshotPath,
    });
  } finally {
    await receiver.close();
  }
});
