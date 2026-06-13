import { expect, test } from "@playwright/test";
import {
  createSession,
  makeSizedTestFile,
  newReceiverPage,
  openReceiver,
} from "./p2p-file-v1.support";

test.describe("large transfer coverage", () => {
  test("direct transfer completes a large zip file", async ({ page }) => {
    test.setTimeout(60_000);
    const files = [makeSizedTestFile("large-transfer.zip", 2 * 1024 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();

      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(receiver.getByRole("button", { name: "保存 large-transfer.zip" })).toBeVisible();
    } finally {
      await receiver.close();
    }
  });
});
