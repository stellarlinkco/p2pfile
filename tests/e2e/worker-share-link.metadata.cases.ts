import { expect, test } from "@playwright/test";
import { accessCodeFrom, createSession, openReceiver, TEST_FILES } from "./p2p-file-v1.support";
import { observeApiRequests, writeEvidence } from "./worker-share-link.support";

test("Worker same-origin Share Link opens metadata-only Frozen Manifest", async ({ page }) => {
  const apiRequests: string[] = [];
  observeApiRequests(page, apiRequests);

  await page.goto("/receive");
  await expect(page.getByRole("heading", { name: "接收文件" })).toBeVisible();
  const statusResponse = await page.request.get("/api/status");
  expect(statusResponse.ok()).toBe(true);
  expect(await statusResponse.json()).toMatchObject({ ok: true, service: "signal" });

  const shareLink = await createSession(page, TEST_FILES, { fallback: false });
  const senderOrigin = new URL(page.url()).origin;
  expect(new URL(shareLink).origin).toBe(senderOrigin);

  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  await openReceiver(receiver, shareLink, TEST_FILES, { fallback: false });

  expect(apiRequests).toContain(`${senderOrigin}/api/sessions`);
  expect(apiRequests.some((url) => url.startsWith("http://127.0.0.1:3001/"))).toBe(false);
  for (const url of apiRequests) {
    expect(new URL(url).origin).toBe(senderOrigin);
  }
  const receiverManifest = await receiver.getByTestId("receiver-manifest").textContent();
  await writeEvidence("worker-share-link-dom-trace.json", {
    assertionId: "VAL-CF-001",
    shareLink,
    senderOrigin,
    receiverUrl: receiver.url(),
    apiRequests,
    receiverManifest,
    fileContentVisible: await receiver.getByText(/alpha file from playwright|"beta"/i).count(),
  });
});

test("Worker Access Code entry opens the same metadata-only Frozen Manifest", async ({ page }) => {
  const apiRequests: string[] = [];
  observeApiRequests(page, apiRequests);

  const shareLink = await createSession(page, TEST_FILES, { fallback: false });
  const accessCode = await accessCodeFrom(page);
  const senderOrigin = new URL(page.url()).origin;
  const sessionId = new URL(shareLink).pathname.replace("/f/", "");

  const receiver = await page.context().newPage();
  observeApiRequests(receiver, apiRequests);
  await receiver.goto("/receive");
  await receiver.getByTestId("receiver-entry-input").fill(`  ${accessCode.toLowerCase()}  `);
  await receiver.getByTestId("receiver-open-session-button").click();

  await expect(receiver).toHaveURL(new RegExp(`/f/${sessionId}$`));
  const manifest = receiver.getByTestId("receiver-manifest");
  await expect(manifest).toBeVisible();
  for (const file of TEST_FILES) {
    await expect(manifest).toContainText(file.name);
    await expect(manifest).toContainText(String(file.buffer.byteLength));
  }
  await expect(receiver.getByText(/alpha file from playwright|"beta"/i)).toHaveCount(0);
  await expect(receiver.getByTestId("claim-session-button")).toBeVisible();

  expect(apiRequests).toContain(`${senderOrigin}/api/access-codes/${accessCode.toLowerCase()}`);
  expect(apiRequests).toContain(`${senderOrigin}/api/sessions/${sessionId}`);
  expect(apiRequests.some((url) => url.startsWith("http://127.0.0.1:3001/"))).toBe(false);

  await writeEvidence("worker-access-code-dom-trace.json", {
    assertionId: "VAL-CF-002",
    accessCode,
    normalizedEntry: accessCode.toLowerCase(),
    shareLink,
    senderOrigin,
    receiverUrl: receiver.url(),
    apiRequests,
    receiverManifest: await manifest.textContent(),
    fileContentVisible: await receiver.getByText(/alpha file from playwright|"beta"/i).count(),
  });
});
