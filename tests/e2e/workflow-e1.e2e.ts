import { expect, test } from "@playwright/test";
import {
  blockFallbackSignals,
  createSession,
  forceDirectFail,
  newReceiverPage,
  openReceiver,
  pauseFallbackAfterFiles,
  TEST_FILES,
  type TestFile,
  waitForCompletedSession,
} from "./p2p-file-v1.support";

const RESUME_FILES: TestFile[] = [
  {
    name: "resume-first.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("first file survives receiver reload\n", "utf8"),
  },
  {
    name: "resume-second.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(512 * 1024, 7),
  },
];

test.describe("workflow E1 browser proofs", () => {
  test("receiver retry budget exhaustion shows recreate guidance to original and later visitors", async ({
    page,
  }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);
    const visitor = await newReceiverPage(page);

    await blockFallbackSignals(receiver);

    try {
      await openReceiver(receiver, shareLink);
      await receiver.getByTestId("claim-session-button").click();
      for (let reclaim = 0; reclaim < 5; reclaim += 1) {
        await receiver.reload();
        await expect
          .poll(async () => {
            const exhausted = await receiver
              .getByTestId("retry-exhausted-notice")
              .isVisible()
              .catch(() => false);
            const claim = await receiver
              .getByTestId("claim-session-button")
              .isVisible()
              .catch(() => false);
            return exhausted || claim;
          })
          .toBe(true);
        if (
          await receiver
            .getByTestId("retry-exhausted-notice")
            .isVisible()
            .catch(() => false)
        ) {
          break;
        }
      }

      await expect(receiver.getByTestId("retry-exhausted-notice")).toBeVisible();
      await expect(receiver.getByTestId("retry-exhausted-notice")).toContainText(/重新创建/);

      await visitor.goto(shareLink);
      await expect(visitor.getByTestId("retry-exhausted-notice")).toBeVisible();
      await expect(visitor.getByTestId("session-status")).toContainText(/Retry Budget|重新创建/);
    } finally {
      await receiver.close();
      await visitor.close();
    }
  });

  test("forced production direct failure discloses relay mode and completes", async ({ page }) => {
    const shareLink = await createSession(page, TEST_FILES, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    await forceDirectFail(receiver);

    try {
      await openReceiver(receiver, shareLink, TEST_FILES, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();

      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer|中继/i);
      await expect(page.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer|中继/i);
      await waitForCompletedSession(receiver);
      await waitForCompletedSession(page);
    } finally {
      await receiver.close();
    }
  });

  test("interrupted fallback receiver reclaims token and resumes after completed first file", async ({
    page,
  }) => {
    await pauseFallbackAfterFiles(page, 1);
    const shareLink = await createSession(page, RESUME_FILES);
    const receiver = await newReceiverPage(page);

    try {
      await receiver.goto(shareLink);
      await expect(receiver.getByTestId("receiver-manifest")).toContainText("resume-first.txt");
      await expect(receiver.getByTestId("receiver-manifest")).toContainText("resume-second.bin");
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByText("1 / 2 completed")).toBeVisible({ timeout: 30_000 });

      await receiver.reload();
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByText(/1 \/ 2 completed|2 \/ 2 completed/)).toBeVisible();

      await waitForCompletedSession(receiver);
      await waitForCompletedSession(page);
      await expect(receiver.getByRole("button", { name: "保存 resume-first.txt" })).toHaveCount(1);
      await expect(receiver.getByRole("button", { name: "保存 resume-second.bin" })).toHaveCount(1);
    } finally {
      await receiver.close();
    }
  });
});
