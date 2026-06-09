import { expect, type Page, test } from "@playwright/test";

type TestFile = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

const TEST_FILES: TestFile[] = [
  {
    name: "notes-alpha.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("alpha file from playwright\n", "utf8"),
  },
  {
    name: "notes-beta.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ beta: true, count: 2 }), "utf8"),
  },
];

async function enableTransferFallback(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__P2PFILE_TEST_FALLBACK__", {
      configurable: true,
      value: true,
    });
  });
}

async function createSession(page: Page, files: TestFile[] = TEST_FILES) {
  await enableTransferFallback(page);
  await page.goto("/");
  await page.getByTestId("sender-file-input").setInputFiles(files);
  await page.getByTestId("create-session-button").click();

  const manifest = page.getByTestId("frozen-manifest");
  await expect(manifest).toBeVisible();
  for (const file of files) {
    await expect(manifest).toContainText(file.name);
  }
  await expect(page.getByTestId("share-link")).toBeVisible();
  await expect(page.getByTestId("access-code")).toBeVisible();
  await expect(page.getByTestId("qr-code")).toBeVisible();
  const qrImage = page.getByTestId("qr-code").getByRole("img", {
    name: "QR Code for Share Link",
  });
  await expect(qrImage).toHaveAttribute("src", /^data:image\/png;base64,/);

  return shareLinkFrom(page);
}

async function shareLinkFrom(page: Page) {
  const shareLink = page.getByTestId("share-link");
  const rawLink =
    (await shareLink.getAttribute("href")) ??
    (await shareLink.inputValue().catch(() => null)) ??
    (await shareLink.textContent());

  expect(rawLink, "Share Link must expose a copyable URL").toBeTruthy();
  return new URL(rawLink?.trim() ?? "", page.url()).toString();
}

async function openReceiver(page: Page, shareLink: string, files: TestFile[] = TEST_FILES) {
  await enableTransferFallback(page);
  await page.goto(shareLink);

  const manifest = page.getByTestId("receiver-manifest");
  await expect(manifest).toBeVisible();
  for (const file of files) {
    await expect(manifest).toContainText(file.name);
    await expect(manifest).toContainText(String(file.buffer.byteLength));
  }
  await expect(page.getByText(/alpha file from playwright|"beta"/i)).toHaveCount(0);
  await expect(page.getByTestId("claim-session-button")).toBeVisible();
}

async function newReceiverPage(page: Page) {
  const receiverPage = await page.context().newPage();
  await enableTransferFallback(receiverPage);
  return receiverPage;
}

async function countVisible(pages: Page[], testId: string) {
  const states = await Promise.all(
    pages.map((page) =>
      page
        .getByTestId(testId)
        .isVisible()
        .catch(() => false),
    ),
  );
  return states.filter(Boolean).length;
}

test.describe("P2P File v1 session flow", () => {
  test("sender creates a multi-file session with frozen manifest and all share surfaces", async ({
    page,
  }) => {
    await createSession(page);
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
      await expect(receiver.getByRole("button", { name: "保存" }).first()).toBeVisible();
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

declare global {
  interface Window {
    __P2PFILE_TEST_FALLBACK__?: boolean;
  }
}
