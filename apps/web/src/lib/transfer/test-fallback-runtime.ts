import {
  type FileManifestItem,
  type ResumeProgress,
  resumeProgressFromManifest,
} from "@p2pfile/shared";
import { createSha256Digest } from "./digest";
import { applyMode, buildReceiverState, handleProtocolMessage } from "./runtime-shared";
import {
  buildTransferPlan,
  initialResumeProgress,
  reportResumeProgress,
} from "./sender-runtime-helpers";
import { createChannelName, restoreProgressState } from "./test-fallback-helpers";
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

function shouldCorruptFirstChunkDigest(fileId: string, chunkIndex: number) {
  const target = globalThis as {
    __P2PFILE_TEST_BAD_CHUNK_DIGEST__?: boolean | { fileId?: string; chunkIndex?: number };
  };
  const value = target.__P2PFILE_TEST_BAD_CHUNK_DIGEST__;
  if (!value) return false;
  if (value === true) return chunkIndex === 0;
  return (
    (value.fileId === undefined || value.fileId === fileId) &&
    (value.chunkIndex === undefined || value.chunkIndex === chunkIndex)
  );
}

function postProtocolMessage(channel: BroadcastChannel, message: TransferProtocolMessage) {
  try {
    channel.postMessage(message);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      return false;
    }
    throw error;
  }
}

async function sendTransfer(
  channel: BroadcastChannel,
  files: File[],
  handlers: SenderRuntimeHandlers,
  frozenManifest?: FileManifestItem[],
  progress: ResumeProgress = initialResumeProgress(buildTransferPlan(files, frozenManifest)),
  onFinished: () => void = () => undefined,
  shouldContinue = () => true,
) {
  const plan = buildTransferPlan(files, frozenManifest);
  const manifest = plan.manifest;
  const totalBytes = plan.totalBytes;
  const normalizedCompletedFiles = progress.files.filter((file) => file.completed).length;
  handlers.onMode("relay");
  handlers.onStatus("Relayed Transfer connected");
  if (!shouldContinue()) return;
  if (
    !postProtocolMessage(channel, {
      type: "manifest",
      files: manifest,
      totalBytes,
      manifestHash: plan.manifestHash,
    })
  )
    return;
  if (!shouldContinue()) return;
  await sleep(0);

  let completedBytes = progress.files.reduce((sum, file) => sum + file.committedBytes, 0);
  let sentCompletedFiles = normalizedCompletedFiles;
  if (completedBytes > 0) {
    reportResumeProgress(plan, progress, handlers);
  }
  for (
    let index = progress.files.findIndex((file) => !file.completed);
    index >= 0 && index < files.length;
    index += 1
  ) {
    const file = files[index];
    const manifestItem = manifest[index];
    const resumeFile = progress.files[index];
    if (!file || !manifestItem || !resumeFile) continue;

    const resumeOffset = Math.max(0, Math.min(resumeFile.committedBytes, file.size));
    const completedBytesBeforeFile = completedBytes - resumeOffset;
    if (!shouldContinue()) return;
    if (
      !postProtocolMessage(channel, {
        type: "file-start",
        file: manifestItem,
        offset: resumeOffset,
      })
    )
      return;
    let fileBytes = resumeOffset;
    const digest = createSha256Digest();
    if (resumeOffset > 0) {
      digest.update(await file.slice(0, resumeOffset).arrayBuffer());
    }
    for (let offset = resumeOffset; offset < file.size; offset += 64 * 1024) {
      const bytes = await file.slice(offset, offset + 64 * 1024).arrayBuffer();
      if (!shouldContinue()) return;
      if (
        !postProtocolMessage(channel, {
          type: "chunk",
          fileId: manifestItem.id,
          chunkIndex: Math.floor(offset / (64 * 1024)),
          offset,
          bytes,
          chunkDigest: shouldCorruptFirstChunkDigest(
            manifestItem.id,
            Math.floor(offset / (64 * 1024)),
          )
            ? "0".repeat(64)
            : await crypto.subtle
                .digest("SHA-256", bytes)
                .then((digest) =>
                  Array.from(new Uint8Array(digest), (byte) =>
                    byte.toString(16).padStart(2, "0"),
                  ).join(""),
                ),
        })
      )
        return;
      digest.update(bytes);
      fileBytes += bytes.byteLength;
      handlers.onProgress({
        fileId: manifestItem.id,
        fileName: manifestItem.name,
        fileBytes,
        fileTotalBytes: manifestItem.size,
        completedBytes: completedBytesBeforeFile + fileBytes,
        totalBytes,
        completedFiles: sentCompletedFiles,
        totalFiles: files.length,
      });
      await sleep(0);
    }

    if (!shouldContinue()) return;
    if (
      !postProtocolMessage(channel, {
        type: "file-end",
        fileId: manifestItem.id,
        bytes: fileBytes,
        digest: digest.digestHex(),
      })
    )
      return;
    completedBytes = completedBytesBeforeFile + fileBytes;
    sentCompletedFiles += 1;
    await sleep(0);
    if (pauseAfterCompletedFiles() === sentCompletedFiles) return;
  }

  if (!shouldContinue()) return;
  if (postProtocolMessage(channel, { type: "complete", totalBytes })) {
    onFinished();
  }
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
      const progress =
        typeof message.payload === "object" &&
        message.payload !== null &&
        "progress" in message.payload
          ? (message.payload.progress as ResumeProgress)
          : initialResumeProgress(buildTransferPlan(files, manifest));
      const completedFiles = progress.files.filter((file) => file.completed).length;
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
        progress,
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
  committedBytesByFileId: ReadonlyMap<string, number> = new Map(),
): Promise<ReceiverRuntime> {
  const channel = new BroadcastChannel(createChannelName(sessionId));
  const expected = expectedManifest.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
  }));
  const seededCommittedBytes = new Map(committedBytesByFileId);
  for (const file of receivedFiles) {
    seededCommittedBytes.set(file.id, file.size);
  }
  const state = buildReceiverState(expected, seededCommittedBytes, sessionId);
  let stopped = false;
  let completed = false;
  if (seededCommittedBytes.size > 0) {
    restoreProgressState(expected, receivedFiles, handlers, seededCommittedBytes);
  }

  handlers.onMode("relay");
  handlers.onStatus("Relayed Transfer connected");
  const processProtocolMessage = async (message: TransferProtocolMessage) => {
    if (stopped || completed) return;

    try {
      await handleProtocolMessage(message, state, handlers, {
        onChunkCommit(ack) {
          channel.postMessage(ack satisfies TransferProtocolMessage);
        },
      });
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
    payload: {
      progress: resumeProgressFromManifest(expected, seededCommittedBytes),
      completedFiles: state.receivedFiles,
    },
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
