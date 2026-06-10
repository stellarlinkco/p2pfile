import { expect, test } from "@playwright/test";
import {
  accessCodeFrom,
  blockReceiverStorageAndFallbackSignals,
  countVisible,
  createSession,
  enableTransferFallback,
  newReceiverPage,
  openReceiver,
  qrShareLinkFrom,
  TEST_FILES,
} from "./p2p-file-v1.support";

test.describe("P2P File v1 session flow", () => {
  test("sender upload surface only advertises available file-picker behavior", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("选择文件", { exact: true })).toBeVisible();
    await expect(page.getByText(/拖拽文件/)).toHaveCount(0);
  });

  test("sender status distinguishes waiting from active transfer", async ({ page }) => {
    await enableTransferFallback(page);
    await page.goto("/");
    await page.getByTestId("sender-file-input").setInputFiles(TEST_FILES);
    await page.getByTestId("create-session-button").click();

    await expect(page.getByText("等待接收方", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("传输中 ●")).toHaveCount(0);
  });

  test("sender receives visible feedback after copying Share Link", async ({ page }) => {
    await enableTransferFallback(page);
    await page.goto("/");
    await page
      .context()
      .grantPermissions(["clipboard-write"], { origin: new URL(page.url()).origin });
    await page.getByTestId("sender-file-input").setInputFiles(TEST_FILES);
    await page.getByTestId("create-session-button").click();

    await page.getByRole("button", { name: "复制链接" }).click();

    await expect(page.getByText("已复制")).toBeVisible();
  });
  test("sender hides share surfaces when runtime startup fails", async ({ page }) => {
    await page.addInitScript(() => {
      class BrokenWebSocket {
        constructor() {
          throw new Error("blocked websocket");
        }
      }

      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        value: BrokenWebSocket,
      });
    });
    await page.goto("/");
    await page.getByTestId("sender-file-input").setInputFiles(TEST_FILES);
    await page.getByTestId("create-session-button").click();

    await expect(page.getByTestId("session-status")).toContainText(/失败|failed/i);
    await expect(page.getByTestId("share-link")).toHaveCount(0);
    await expect(page.getByTestId("qr-code")).toHaveCount(0);
  });

  test("sender creates a multi-file session with frozen manifest and all share surfaces", async ({
    page,
  }) => {
    await createSession(page);
  });

  test("sender Frozen Manifest stays frozen after session creation", async ({ page }) => {
    await createSession(page);

    await page.getByTestId("sender-file-input").setInputFiles({
      name: "replacement.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("replacement", "utf8"),
    });

    const manifest = page.getByTestId("frozen-manifest");
    await expect(manifest).toContainText("notes-alpha.txt");
    await expect(manifest).not.toContainText("replacement.txt");
  });

  test("receiver opens Share Link and sees metadata-only manifest before claim", async ({
    page,
  }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    try {
      await openReceiver(receiver, shareLink);
    } finally {
      await receiver.close();
    }
  });

  test("claim conflict allows exactly one receiver and shows occupied notice to the other", async ({
    page,
  }) => {
    const shareLink = await createSession(page);
    const first = await newReceiverPage(page);
    const second = await newReceiverPage(page);

    try {
      await Promise.all([openReceiver(first, shareLink), openReceiver(second, shareLink)]);
      await Promise.all([
        first.getByTestId("claim-session-button").click(),
        second.getByTestId("claim-session-button").click(),
      ]);

      await expect
        .poll(() => countVisible([first, second], "occupied-session-notice"), {
          message: "exactly one receiver must be rejected as occupied",
        })
        .toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("receiver cannot open another entry while claim is active", async ({ page }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    await receiver.addInitScript(() => {
      const originalPostMessage = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function postMessage(message: unknown) {
        if (typeof this.name === "string" && this.name.startsWith("p2pfile:test:")) {
          return undefined;
        }

        return originalPostMessage.call(this, message);
      };
    });

    try {
      await openReceiver(receiver, shareLink);
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByTestId("receiver-open-session-button")).toBeDisabled();
    } finally {
      await receiver.close();
    }
  });

  test("receiver claim continues when token storage is unavailable", async ({ page }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    await blockReceiverStorageAndFallbackSignals(receiver);

    try {
      await openReceiver(receiver, shareLink);
      await receiver.getByTestId("claim-session-button").click();
      await expect(receiver.getByRole("button", { name: "放弃接收" })).toBeVisible();
      await expect(receiver.getByTestId("session-status")).not.toContainText(/failed|失败/i);
      await receiver.getByRole("button", { name: "放弃接收" }).click();
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
    } finally {
      await receiver.close();
    }
  });

  test("share-link entry remains horizontally accessible on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createSession(page);

    await expect(page.getByTestId("share-link")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  });

  test("multi-file transfer completes for sender and receiver with mode disclosure", async ({
    page,
  }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    try {
      await openReceiver(receiver, shareLink);
      await receiver.getByTestId("claim-session-button").click();

      await expect(receiver.getByTestId("mode-disclosure")).toContainText(
        /Direct Transfer|Relayed Transfer|直传|中继/i,
      );
      await expect(page.getByTestId("mode-disclosure")).toContainText(
        /Direct Transfer|Relayed Transfer|直传|中继/i,
      );
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(receiver.getByRole("link", { name: "接收其他会话" })).toBeVisible();
      await expect(receiver.getByRole("button", { name: "保存 notes-alpha.txt" })).toBeVisible();
      await expect(receiver.getByRole("button", { name: "保存 notes-beta.json" })).toBeVisible();
    } finally {
      await receiver.close();
    }
  });
  test("receiver can open the same session through Access Code entry", async ({ page }) => {
    const shareLink = await createSession(page);
    const sessionId = new URL(shareLink).pathname.split("/").pop();
    if (!sessionId) {
      throw new Error("share link missing session id");
    }

    const accessCode = await accessCodeFrom(page);
    const receiver = await newReceiverPage(page);

    try {
      await receiver.goto("/receive");
      await receiver.getByTestId("receiver-entry-input").fill(accessCode);
      await receiver.getByTestId("receiver-open-session-button").click();
      await expect(receiver).toHaveURL(new RegExp(`/f/${sessionId}$`));
      await expect(receiver.getByTestId("receiver-manifest")).toBeVisible();
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
    } finally {
      await receiver.close();
    }
  });

  test("QR Code encodes a share link that opens the same session", async ({ page }) => {
    const shareLink = await createSession(page);
    const qrShareLink = await qrShareLinkFrom(page);
    const receiver = await newReceiverPage(page);

    expect(qrShareLink).toBe(shareLink);

    try {
      await openReceiver(receiver, qrShareLink);
      await expect(receiver.getByTestId("claim-session-button")).toBeVisible();
    } finally {
      await receiver.close();
    }
  });

  test("direct transfer completes without the test fallback runtime", async ({ page }) => {
    const shareLink = await createSession(page, TEST_FILES, { fallback: false });
    const receiver = await newReceiverPage(page, { fallback: false });

    try {
      await openReceiver(receiver, shareLink, TEST_FILES, { fallback: false });
      await receiver.getByTestId("claim-session-button").click();

      await expect(receiver.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(page.getByTestId("mode-disclosure")).toContainText(/Direct Transfer|直传/i);
      await expect(
        receiver.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("heading", { level: 3, name: "Completed Session View" }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await receiver.close();
    }
  });

  test("sender exit ends the receiver session", async ({ page }) => {
    const shareLink = await createSession(page);
    const receiver = await newReceiverPage(page);

    try {
      await openReceiver(receiver, shareLink);
      await page.getByRole("button", { name: "结束会话" }).click();
      await expect(receiver.getByTestId("ended-session-notice")).toBeVisible({
        timeout: 15_000,
      });
      await expect(receiver.getByTestId("ended-session-notice")).toContainText(
        /发送方|sender|结束|ended|重新创建/i,
      );
    } finally {
      await receiver.close();
    }
  });
});
