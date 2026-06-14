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
      const sessionId = new URL(shareLink).pathname.split("/").pop();
      if (!sessionId) throw new Error("Share Link is missing a session id.");

      await expect
        .poll(() =>
          receiver.evaluate((id) => localStorage.getItem(`p2pfile:receiver:${id}`), sessionId),
        )
        .not.toBeNull();
      const receiverToken = await receiver.evaluate(
        (id) => localStorage.getItem(`p2pfile:receiver:${id}`),
        sessionId,
      );
      if (!receiverToken) throw new Error("Receiver Token was not cached after claim.");

      const exhaustedClaim = await receiver.evaluate(
        async ({ sessionId, receiverToken }) => {
          const origin = new URL(window.location.origin);
          if (origin.port === "4173") origin.port = "3001";

          let claim = "";
          for (let attempt = 0; attempt < 5 && claim !== "failed"; attempt += 1) {
            const response = await fetch(`${origin.origin}/api/sessions/${sessionId}/claim`, {
              body: JSON.stringify({ receiverToken }),
              headers: { "content-type": "application/json" },
              method: "POST",
            });
            if (!response.ok) throw new Error(`Retry claim failed with ${response.status}.`);
            const payload = (await response.json()) as { claim?: string; status?: string };
            claim = payload.claim ?? payload.status ?? "";
          }
          return claim;
        },
        { sessionId, receiverToken },
      );
      expect(exhaustedClaim).toBe("failed");

      await receiver.reload();

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
      await expect(receiver.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });

      await receiver.reload();
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByText(/^(1 \/ 2|2 \/ 2)$/)).toBeVisible();

      await waitForCompletedSession(receiver);
      await waitForCompletedSession(page);
      await expect(receiver.getByRole("button", { name: "保存 resume-first.txt" })).toHaveCount(1);
      await expect(receiver.getByRole("button", { name: "保存 resume-second.bin" })).toHaveCount(1);
    } finally {
      await receiver.close();
    }
  });
});
