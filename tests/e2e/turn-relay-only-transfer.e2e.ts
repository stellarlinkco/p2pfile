import { expect, test } from "@playwright/test";
import {
  createSession,
  makeSizedTestFile,
  newReceiverPage,
  openReceiver,
} from "./p2p-file-v1.support";
import { turnSandboxConfigured } from "./transfer-stability.support";
import { writeEvidence } from "./worker-share-link.support";

test.describe("turn relay-only transfer", () => {
  test("relay-only TURN transfer completes when sandbox credentials exist", async ({ page }) => {
    test.skip(!turnSandboxConfigured(), "Blocked until VITE_TURN_URL credentials are configured.");
    test.setTimeout(120_000);

    const files = [makeSizedTestFile("turn-relay-only.zip", 512 * 1024, "application/zip")];
    const shareLink = await createSession(page, files, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, files, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Relayed Transfer/i);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 90_000 });

      await writeEvidence("val-stab-006-turn-relay-only-dom-trace.json", {
        assertionId: "VAL-STAB-006",
        evidenceSource: "controlled",
        shareLink,
        modeDisclosure: await receiver.getByTestId("mode-disclosure").textContent(),
      });
    } finally {
      await receiver.close();
    }
  });
});
