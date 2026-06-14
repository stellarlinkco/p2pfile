import { expect, type Page } from "@playwright/test";

export type TestFile = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

export const TEST_FILES: TestFile[] = [
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

export function makeSizedTestFile(
  name: string,
  size: number,
  mimeType = "application/octet-stream",
): TestFile {
  const buffer = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    buffer[index] = (index * 17 + size) % 251;
  }
  return { name, mimeType, buffer };
}

function formatExpectedBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export async function enableTransferFallback(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__P2PFILE_TEST_FALLBACK__", {
      configurable: true,
      value: true,
    });
  });
}

export async function pauseFallbackAfterFiles(page: Page, completedFiles: number) {
  await page.addInitScript((value) => {
    Object.defineProperty(window, "__P2PFILE_TEST_PAUSE_AFTER_FILES__", {
      configurable: true,
      value,
    });
  }, completedFiles);
}

export async function forceDirectFail(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__P2PFILE_FORCE_DIRECT_FAIL__", {
      configurable: true,
      value: true,
    });
  });
}
export async function slowDirectChunks(page: Page, delayMs: number) {
  await page.addInitScript((value) => {
    Object.defineProperty(window, "__P2PFILE_TEST_CHUNK_DELAY_MS__", {
      configurable: true,
      value,
    });
  }, delayMs);
}
export async function recordTransferEvents(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__P2PFILE_TEST_TRANSFER_EVENTS__", {
      configurable: true,
      value: [],
    });
  });
}

export async function corruptFirstFallbackChunkDigest(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__P2PFILE_TEST_BAD_CHUNK_DIGEST__", {
      configurable: true,
      value: true,
    });
  });
}

export async function blockFallbackSignals(page: Page) {
  await page.addInitScript(() => {
    const originalPostMessage = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function postMessage(message: unknown) {
      if (typeof this.name === "string" && this.name.startsWith("p2pfile:test:")) {
        return undefined;
      }
      return originalPostMessage.call(this, message);
    };
  });
}

export async function waitForCompletedSession(page: Page) {
  await expect(page.getByTestId("completed-session-view")).toBeVisible({ timeout: 30_000 });
}

export async function createSession(
  page: Page,
  files: TestFile[] = TEST_FILES,
  options: { fallback?: boolean } = {},
) {
  if (options.fallback ?? true) {
    await enableTransferFallback(page);
  }
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

export async function shareLinkFrom(page: Page) {
  const shareLink = page.getByTestId("share-link");
  const rawLink =
    (await shareLink.getAttribute("href")) ??
    (await shareLink.inputValue().catch(() => null)) ??
    (await shareLink.textContent());

  expect(rawLink, "Share Link must expose a copyable URL").toBeTruthy();
  return new URL(rawLink?.trim() ?? "", page.url()).toString();
}

export async function accessCodeFrom(page: Page) {
  const rawCode =
    (await page
      .getByTestId("access-code")
      .inputValue()
      .catch(() => null)) ?? (await page.getByTestId("access-code").textContent());

  expect(rawCode, "Access Code must be visible").toBeTruthy();
  return rawCode?.trim() ?? "";
}

export async function qrShareLinkFrom(page: Page) {
  const decoded = await page.evaluate(async () => {
    const Detector = (
      globalThis as {
        BarcodeDetector?: new (options: {
          formats: string[];
        }) => {
          detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>;
        };
      }
    ).BarcodeDetector;
    if (!Detector) {
      throw new Error("BarcodeDetector unavailable.");
    }

    const image = document.querySelector<HTMLImageElement>('[data-testid="qr-code"] img');
    if (!image?.src) {
      throw new Error("QR image missing.");
    }

    const element = new Image();
    element.src = image.src;
    await element.decode();

    const detector = new Detector({ formats: ["qr_code"] });
    const matches = await detector.detect(element);
    const rawValue = matches[0]?.rawValue;
    if (!rawValue) {
      throw new Error("QR decode failed.");
    }

    return rawValue;
  });

  return new URL(decoded, page.url()).toString();
}

export async function openReceiver(
  page: Page,
  shareLink: string,
  files: TestFile[] = TEST_FILES,
  options: { fallback?: boolean } = {},
) {
  if (options.fallback ?? true) {
    await enableTransferFallback(page);
  }
  await page.goto(shareLink);

  const manifest = page.getByTestId("receiver-manifest");
  await expect(manifest).toBeVisible();
  for (const file of files) {
    await expect(manifest).toContainText(file.name);
    await expect(manifest).toContainText(formatExpectedBytes(file.buffer.byteLength));
  }
  await expect(page.getByText(/alpha file from playwright|"beta"/i)).toHaveCount(0);
  await expect(page.getByTestId("claim-session-button")).toBeVisible();
}

export async function newReceiverPage(page: Page, options: { fallback?: boolean } = {}) {
  const receiverPage = await page.context().newPage();
  if (options.fallback ?? true) {
    await enableTransferFallback(receiverPage);
  }
  return receiverPage;
}

export async function blockReceiverStorageAndFallbackSignals(page: Page) {
  await page.addInitScript(() => {
    const getItem = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.setItem = (() => {
      throw new Error("storage blocked");
    }) as Storage["setItem"];
    window.localStorage.removeItem = (() => {
      throw new Error("storage blocked");
    }) as Storage["removeItem"];
    window.localStorage.getItem = ((key: string) => getItem(key)) as Storage["getItem"];
    const originalPostMessage = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function postMessage(message: unknown) {
      if (typeof this.name === "string" && this.name.startsWith("p2pfile:test:")) {
        return undefined;
      }
      return originalPostMessage.call(this, message);
    };
  });
}

export async function countVisible(pages: Page[], testId: string) {
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
