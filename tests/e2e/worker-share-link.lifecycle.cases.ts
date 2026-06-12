import { expect, test } from "@playwright/test";
import { createSession, openReceiver, TEST_FILES } from "./p2p-file-v1.support";
import {
  createSessionViaApi,
  observeApiRequests,
  observeWebSockets,
  writeEvidence,
} from "./worker-share-link.support";

test("Worker Receiver Token claim shows occupied notice, supports re-entry, and release reopens", async ({
  page,
  browser,
}) => {
  const apiRequests: string[] = [];
  observeApiRequests(page, apiRequests);

  const shareLink = await createSessionViaApi(page, TEST_FILES);
  const senderOrigin = new URL(shareLink).origin;

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const reopenedContext = await browser.newContext();
  try {
    const firstReceiver = await firstContext.newPage();
    const secondReceiver = await secondContext.newPage();
    const reopenedReceiver = await reopenedContext.newPage();
    observeApiRequests(firstReceiver, apiRequests);
    observeApiRequests(secondReceiver, apiRequests);
    observeApiRequests(reopenedReceiver, apiRequests);

    await openReceiver(firstReceiver, shareLink, TEST_FILES, { fallback: false });
    await firstReceiver.getByTestId("claim-session-button").click();
    await expect(firstReceiver.getByRole("button", { name: "放弃接收" })).toBeVisible();

    await secondReceiver.goto(shareLink);
    await expect(secondReceiver.getByTestId("occupied-session-notice")).toBeVisible();
    await expect(secondReceiver.getByTestId("claim-session-button")).toHaveCount(0);

    await firstReceiver.reload();
    await expect(firstReceiver.getByTestId("occupied-session-notice")).toHaveCount(0);
    await expect(firstReceiver.getByTestId("claim-session-button")).toBeVisible();
    await firstReceiver.getByTestId("claim-session-button").click();
    await expect(firstReceiver.getByRole("button", { name: "放弃接收" })).toBeVisible();

    await firstReceiver.getByRole("button", { name: "放弃接收" }).click();
    await expect(firstReceiver.getByTestId("claim-session-button")).toBeVisible();

    await openReceiver(reopenedReceiver, shareLink, TEST_FILES, { fallback: false });
    await reopenedReceiver.getByTestId("claim-session-button").click();
    await expect(reopenedReceiver.getByRole("button", { name: "放弃接收" })).toBeVisible();

    await writeEvidence("worker-receiver-token-claim-release-dom-trace.json", {
      assertionId: "VAL-CF-003",
      workUnitId: "wu-07d4dd78",
      evidenceSource: "controlled",
      shareLink,
      senderOrigin,
      firstReceiverUrl: firstReceiver.url(),
      secondReceiverUrl: secondReceiver.url(),
      reopenedReceiverUrl: reopenedReceiver.url(),
      apiRequests,
      occupiedNoticeVisible: await secondReceiver.getByTestId("occupied-session-notice").count(),
      firstReceiverCanRelease: await firstReceiver
        .getByRole("button", { name: "放弃接收" })
        .count(),
      reopenedReceiverCanRelease: await reopenedReceiver
        .getByRole("button", { name: "放弃接收" })
        .count(),
    });
  } finally {
    await firstContext.close();
    await secondContext.close();
    await reopenedContext.close();
  }
});

test("Worker sender exit creates Sender-Ended Session with rebuild-only receiver UI", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  const websocketRequests: string[] = [];
  observeApiRequests(page, apiRequests);
  observeWebSockets(page, websocketRequests);

  const shareLink = await createSession(page, TEST_FILES, { fallback: false });
  const senderOrigin = new URL(page.url()).origin;
  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  observeWebSockets(receiver, websocketRequests);

  try {
    await openReceiver(receiver, shareLink, TEST_FILES, { fallback: false });
    await receiver.getByTestId("claim-session-button").click();
    await expect(receiver.getByRole("button", { name: "放弃接收" })).toBeVisible();

    await page.getByRole("button", { name: "结束会话" }).click();

    const endedNotice = receiver.getByTestId("ended-session-notice");
    await expect(endedNotice).toBeVisible({ timeout: 15_000 });
    await expect(endedNotice).toContainText(/Sender-Ended Session|重新创建/);
    await expect(receiver.getByTestId("claim-session-button")).toHaveCount(0);
    await expect(receiver.getByRole("button", { name: "放弃接收" })).toHaveCount(0);
    await expect(receiver.getByTestId("completed-session-view")).toHaveCount(0);
    await expect(receiver.getByTestId("mode-disclosure")).toHaveCount(0);

    await writeEvidence("worker-sender-ended-dom-trace.json", {
      assertionId: "VAL-CF-004",
      shareLink,
      senderOrigin,
      receiverUrl: receiver.url(),
      apiRequests,
      websocketRequests,
      receiverStatus: await receiver.getByTestId("session-status").textContent(),
      endedNotice: await endedNotice.textContent(),
      claimButtonVisible: await receiver.getByTestId("claim-session-button").count(),
      releaseButtonVisible: await receiver.getByRole("button", { name: "放弃接收" }).count(),
      modeDisclosureVisible: await receiver.getByTestId("mode-disclosure").count(),
    });
  } finally {
    await receiver.close();
  }
});
