import type { FileManifestItem } from "@p2pfile/shared";
import { computeDigestHex } from "./digest";
import { applyMode, buildReceiverState, handleProtocolMessage } from "./runtime-shared";
import { reportResumeProgress } from "./sender-runtime-helpers";
import {
  createChannelName,
  manifestFromFiles,
  restoreProgressState,
} from "./test-fallback-helpers";
import type {
  ReceivedFile,
  ReceiverRuntime,
  ReceiverRuntimeHandlers,
  SenderRuntime,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

function pauseAfterCompletedFiles() {
  const value = (globalThis as { __P2PFILE_TEST_PAUSE_AFTER_FILES__?: number })
    .__P2PFILE_TEST_PAUSE_AFTER_FILES__;
  return typeof value === "number" ? value : null;
}

async function sendTransfer(
  channel: BroadcastChannel,
  files: File[],
  handlers: SenderRuntimeHandlers,
  frozenManifest?: FileManifestItem[],
  completedFiles = 0,
  onFinished: () => void = () => undefined,
  shouldContinue = () => true,
) {
  const manifest = manifestFromFiles(files, frozenManifest);
  const totalBytes = manifest.reduce((sum, file) => sum + file.size, 0);
  const normalizedCompletedFiles = Math.max(0, Math.min(completedFiles, manifest.length));
  handlers.onMode("relay");
  handlers.onStatus("Relayed Transfer connected");
  channel.postMessage({
    type: "manifest",
    files: manifest,
    totalBytes,
  } satisfies TransferProtocolMessage);
  await sleep(0);

  let completedBytes = manifest
    .slice(0, normalizedCompletedFiles)
    .reduce((sum, file) => sum + file.size, 0);
  let sentCompletedFiles = normalizedCompletedFiles;
  if (normalizedCompletedFiles > 0) {
    reportResumeProgress({ manifest, totalBytes }, normalizedCompletedFiles, handlers);
  }
  for (let index = normalizedCompletedFiles; index < files.length; index += 1) {
    const file = files[index];
    const manifestItem = manifest[index];
    if (!file || !manifestItem) continue;

    if (!shouldContinue()) return;
    channel.postMessage({
      type: "file-start",
      file: manifestItem,
    } satisfies TransferProtocolMessage);
    let fileBytes = 0;
    const sentChunks: ArrayBuffer[] = [];
    for (let offset = 0; offset < file.size; offset += 64 * 1024) {
      const bytes = await file.slice(offset, offset + 64 * 1024).arrayBuffer();
      if (!shouldContinue()) return;
      channel.postMessage({
        type: "chunk",
        fileId: manifestItem.id,
        bytes,
      } satisfies TransferProtocolMessage);
      sentChunks.push(bytes);
      fileBytes += bytes.byteLength;
      handlers.onProgress({
        fileId: manifestItem.id,
        fileName: manifestItem.name,
        fileBytes,
        fileTotalBytes: manifestItem.size,
        completedBytes: completedBytes + fileBytes,
        totalBytes,
        completedFiles: sentCompletedFiles,
        totalFiles: files.length,
      });
      await sleep(0);
    }

    if (!shouldContinue()) return;
    channel.postMessage({
      type: "file-end",
      fileId: manifestItem.id,
      bytes: fileBytes,
      digest: await computeDigestHex(sentChunks),
    } satisfies TransferProtocolMessage);
    completedBytes += fileBytes;
    sentCompletedFiles += 1;
    await sleep(0);
    if (pauseAfterCompletedFiles() === sentCompletedFiles) return;
  }

  if (!shouldContinue()) return;
  channel.postMessage({ type: "complete", totalBytes } satisfies TransferProtocolMessage);
  onFinished();
}

export async function startSenderTestFallbackRuntime(
  sessionId: string,
  _senderToken: string,
  files: File[],
  manifest: FileManifestItem[],
  handlers: SenderRuntimeHandlers,
): Promise<SenderRuntime> {
  const channel = new BroadcastChannel(createChannelName(sessionId));
  let stopped = false;
  let reportedComplete = false;
  let transferToken = 0;
  let activeResumeFrom = -1;

  const close = () => {
    if (!reportedComplete) channel.postMessage({ type: "sender-left", payload: {} });
    channel.close();
  };

  const markReportedComplete = () => {
    if (reportedComplete) return;
    reportedComplete = true;
    handlers.onComplete();
  };

  channel.onmessage = (event) => {
    const message = event.data as TransferProtocolMessage | { type: string; payload?: unknown };
    if (stopped) return;

    if (message.type === "receiver-ready") {
      const completedFiles =
        typeof message.payload === "object" &&
        message.payload !== null &&
        "completedFiles" in message.payload &&
        typeof message.payload.completedFiles === "number"
          ? message.payload.completedFiles
          : 0;
      if (transferToken > 0 && (completedFiles === 0 || completedFiles === activeResumeFrom)) {
        return;
      }
      activeResumeFrom = completedFiles;
      transferToken += 1;
      const token = transferToken;
      if (completedFiles >= manifest.length) {
        channel.postMessage({
          type: "complete",
          totalBytes: manifest.reduce((sum, file) => sum + file.size, 0),
        } satisfies TransferProtocolMessage);
        markReportedComplete();
        return;
      }
      void sendTransfer(
        channel,
        files,
        handlers,
        manifest,
        completedFiles,
        markReportedComplete,
        () => !stopped && token === transferToken,
      );
      return;
    }

    if (message.type === "mode" && typeof message.payload === "object" && message.payload) {
      applyMode((message.payload as { mode: "direct" | "relay" }).mode, handlers);
    }
  };

  return {
    stop() {
      stopped = true;
      close();
    },
    markSenderLeft() {
      close();
    },
  };
}

export async function startReceiverTestFallbackRuntime(
  sessionId: string,
  _receiverToken: string,
  expectedManifest: ReceivedFile[] | { id: string; name: string; size: number }[],
  handlers: ReceiverRuntimeHandlers,
  receivedFiles: ReceivedFile[] = [],
): Promise<ReceiverRuntime> {
  const channel = new BroadcastChannel(createChannelName(sessionId));
  const expected = expectedManifest.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
  }));
  const state = buildReceiverState(expected);
  let stopped = false;
  let completed = false;

  if (receivedFiles.length > 0) {
    for (const file of receivedFiles) {
      handlers.onFileReceived(file);
    }
    state.receivedFiles = receivedFiles.length;
    state.completedBytes = receivedFiles.reduce((sum, file) => sum + file.size, 0);
    restoreProgressState(expected, receivedFiles, handlers);
  }

  handlers.onMode("relay");
  handlers.onStatus("Relayed Transfer connected");
  const processProtocolMessage = async (message: TransferProtocolMessage) => {
    if (stopped || completed) return;

    try {
      await handleProtocolMessage(message, state, handlers);
      if (message.type === "complete") {
        completed = true;
        channel.close();
      }
    } catch (error) {
      stopped = true;
      completed = true;
      channel.close();
      handlers.onError(error instanceof Error ? error.message : "接收文件失败。");
    }
  };

  let processingChain = Promise.resolve();
  channel.onmessage = (event) => {
    if (stopped || completed) return;

    const message = event.data as TransferProtocolMessage | { type: string; payload?: unknown };
    if (message.type === "sender-left") {
      handlers.onEnded();
      return;
    }

    if (message.type === "mode") {
      handlers.onMode((message.payload as { mode: "direct" | "relay" }).mode);
      return;
    }

    if (
      message.type === "manifest" ||
      message.type === "file-start" ||
      message.type === "chunk" ||
      message.type === "file-end" ||
      message.type === "complete"
    ) {
      processingChain = processingChain.then(() =>
        processProtocolMessage(message as TransferProtocolMessage),
      );
    }
  };
  channel.postMessage({
    type: "receiver-ready",
    payload: { completedFiles: receivedFiles.length },
  });

  return {
    stop() {
      stopped = true;
      channel.close();
    },
    release() {
      stopped = true;
      channel.close();
    },
  };
}
