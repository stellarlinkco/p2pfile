import { expect, test } from "@playwright/test";
import {
  createSession,
  forceDirectFail,
  makeSizedTestFile,
  openReceiver,
  TEST_FILES,
  waitForCompletedSession,
} from "./p2p-file-v1.support";
import { observeApiRequests, observeWebSockets, writeEvidence } from "./worker-share-link.support";

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
