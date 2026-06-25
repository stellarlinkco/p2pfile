import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { TEST_FILES, type TestFile } from "./p2p-file-v1.support";

export function observeApiRequests(page: Page, urls: string[]) {
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/")) urls.push(url);
  });
}

export function observeWebSockets(page: Page, urls: string[]) {
  page.on("websocket", (socket) => {
    urls.push(socket.url());
  });
}

export async function writeEvidence(filename: string, data: Record<string, unknown>) {
  const evidenceDir = process.env.EVIDENCE_DIR;
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/${filename}`, JSON.stringify(data, null, 2));
}

export async function writeEvidenceScreenshot(page: Page, filename: string) {
  const evidenceDir = process.env.EVIDENCE_DIR;
  if (!evidenceDir) return null;
  await mkdir(evidenceDir, { recursive: true });
  const path = `${evidenceDir}/${filename}`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function installSenderSocketControl(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    class ControlledWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) {
          super(url);
        } else {
          super(url, protocols);
        }
        if (String(url).includes("/ws/") && String(url).includes("/sender/")) {
          sockets.push(this);
        }
      }
    }
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: ControlledWebSocket,
    });
    Object.defineProperty(window, "__P2PFILE_CLOSE_SENDER_SIGNAL__", {
      configurable: true,
      value: () => {
        const target = sockets.at(-1);
        if (!target) return;
        const replacement = new ControlledWebSocket(target.url);
        replacement.addEventListener("open", () => {
          target.close(1000, "controlled sender interruption");
        });
      },
    });
  });
}

export async function createSessionViaApi(page: Page, files: TestFile[] = TEST_FILES) {
  const response = await page.request.post("/api/sessions", {
    data: {
      manifest: files.map((file, index) => ({
        id: `file-${index + 1}`,
        name: file.name,
        size: file.buffer.byteLength,
        mimeType: file.mimeType,
      })),
    },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { sharePath: string; sessionId: string };
  return new URL(body.sharePath, response.url()).toString();
}

export const VAL_CF_007_FILES: TestFile[] = [
  {
    name: "retry-retained-first.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("first file retained on receiver retry\n", "utf8"),
  },
  {
    name: "retry-unfinished-second.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(128 * 1024, 11),
  },
];

export const VAL_REL_002_FILES: TestFile[] = [
  {
    name: "reconnect-retained-first.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(32 * 1024, 7),
  },
  {
    name: "reconnect-restarted-second.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(2 * 1024 * 1024, 9),
  },
];
