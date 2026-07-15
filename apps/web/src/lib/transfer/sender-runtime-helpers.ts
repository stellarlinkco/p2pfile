import {
  type FileManifestItem,
  MANIFEST_CHUNK_BYTES,
  manifestHash,
  type ResumeProgress,
} from "@p2pfile/shared";
import type { RelayMessageQueue } from "./relay-queue";
import { awaitBufferedAmount, parseProtocolMessage, sendProtocolMessage } from "./runtime-shared";
import {
  buildTransferProgress,
  sendScheduledTransfer,
  type TransferSchedulerOptions,
} from "./transfer-scheduler";
import type { SenderRuntimeHandlers } from "./types";

export type TransferPlan = {
  manifest: FileManifestItem[];
  manifestHash: string;
  totalBytes: number;
};

export function manifestFromFiles(files: File[]) {
  return files.map((file, index) => ({
    id: `file-${index + 1}`,
    name: file.name,
    size: file.size,
  }));
}

export function buildTransferPlan(
  files: File[],
  frozenManifest?: FileManifestItem[],
): TransferPlan {
  const manifest =
    frozenManifest?.map((file) => ({ id: file.id, name: file.name, size: file.size })) ??
    manifestFromFiles(files);
  return {
    manifest,
    manifestHash: manifestHash(manifest),
    totalBytes: manifest.reduce((sum, file) => sum + file.size, 0),
  };
}

function pauseAfterCompletedFiles() {
  const value = (globalThis as { __P2PFILE_TEST_PAUSE_AFTER_FILES__?: number })
    .__P2PFILE_TEST_PAUSE_AFTER_FILES__;
  return typeof value === "number" ? value : null;
}

function recordTransferTestEvent(event: Record<string, unknown>) {
  const target = globalThis as {
    __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
  };
  target.__P2PFILE_TEST_TRANSFER_EVENTS__?.push(event);
}

export function initialResumeProgress(plan: TransferPlan): ResumeProgress {
  return {
    manifestHash: plan.manifestHash,
    files: plan.manifest.map((file) => ({
      fileId: file.id,
      size: file.size,
      chunkSize: MANIFEST_CHUNK_BYTES,
      committedBytes: 0,
      completed: false,
    })),
  };
}

function progressFromCompletedFiles(plan: TransferPlan, completedFiles: number) {
  return {
    manifestHash: plan.manifestHash,
    files: plan.manifest.map((file, index) => ({
      fileId: file.id,
      size: file.size,
      chunkSize: MANIFEST_CHUNK_BYTES,
      committedBytes: index < completedFiles ? file.size : 0,
      completed: index < completedFiles,
    })),
  } satisfies ResumeProgress;
}

function coerceResumeProgress(plan: TransferPlan, progress: ResumeProgress | number) {
  return typeof progress === "number"
    ? progressFromCompletedFiles(plan, Math.max(0, Math.min(progress, plan.manifest.length)))
    : progress;
}

export function completedFilesFromProgress(progress: ResumeProgress) {
  return progress.files.filter((file) => file.completed).length;
}

export function normalizeResumeProgress(plan: TransferPlan, progress: ResumeProgress) {
  if (
    progress.manifestHash !== plan.manifestHash ||
    progress.files.length !== plan.manifest.length
  ) {
    throw new Error("Receiver ResumeProgress manifest mismatch.");
  }
  return {
    manifestHash: progress.manifestHash,
    files: progress.files.map((file, index) => {
      const expected = plan.manifest[index];
      if (!expected || file.fileId !== expected.id || file.size !== expected.size) {
        throw new Error("Receiver ResumeProgress manifest mismatch.");
      }
      if (file.chunkSize !== MANIFEST_CHUNK_BYTES) {
        throw new Error("Receiver ResumeProgress chunk size mismatch.");
      }
      if (file.committedBytes > file.size) {
        throw new Error("Receiver ResumeProgress committed bytes exceed file size.");
      }
      if (file.committedBytes !== file.size && file.committedBytes % file.chunkSize !== 0) {
        throw new Error("Receiver ResumeProgress committed bytes are not chunk aligned.");
      }
      if (file.completed && file.committedBytes !== file.size) {
        throw new Error("Receiver ResumeProgress completed flag does not match committed bytes.");
      }
      return { ...file };
    }),
  } satisfies ResumeProgress;
}

export function mergeResumeProgress(
  plan: TransferPlan,
  currentProgress: ResumeProgress,
  nextProgress: ResumeProgress,
  options: { authoritativeReset?: boolean } = {},
) {
  const current = normalizeResumeProgress(plan, currentProgress);
  const next = normalizeResumeProgress(plan, nextProgress);
  if (options.authoritativeReset) return next;
  return {
    manifestHash: plan.manifestHash,
    files: current.files.map((currentFile, index) => {
      const nextFile = next.files[index];
      if (!nextFile) return currentFile;
      const committedBytes = Math.max(currentFile.committedBytes, nextFile.committedBytes);
      return {
        fileId: currentFile.fileId,
        size: currentFile.size,
        chunkSize: currentFile.chunkSize,
        committedBytes,
        completed:
          committedBytes === currentFile.size && (currentFile.completed || nextFile.completed),
      };
    }),
  } satisfies ResumeProgress;
}

export function reportResumeProgress(
  plan: TransferPlan,
  progress: ResumeProgress,
  handlers: SenderRuntimeHandlers,
) {
  handlers.onProgress(buildTransferProgress(plan, progress, null));
}

export function assertTransferActive(shouldContinue: () => boolean) {
  if (!shouldContinue()) throw new Error("Transfer restarted.");
}

function awaitCommit(
  pendingCommits: Map<string, PromiseWithResolvers<number>>,
  channel: RTCDataChannel,
  fileId: string,
  chunkIndex: number,
  expectedCommittedBytes: number,
  shouldContinue: () => boolean,
) {
  if (typeof channel.addEventListener !== "function") {
    return Promise.resolve(expectedCommittedBytes);
  }
  const key = `${fileId}:${chunkIndex}`;
  const deferred = Promise.withResolvers<number>();
  pendingCommits.set(key, deferred);
  const onClose = () =>
    deferred.reject(
      new Error(shouldContinue() ? "Data channel is not open." : "Transfer restarted."),
    );
  channel.addEventListener("close", onClose, { once: true });
  return deferred.promise.finally(() => {
    channel.removeEventListener("close", onClose);
    pendingCommits.delete(key);
  });
}

function attachCommitListener(
  channel: RTCDataChannel,
  pendingCommits: Map<string, PromiseWithResolvers<number>>,
) {
  if (typeof channel.addEventListener !== "function") return () => undefined;
  const listener = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const message = parseProtocolMessage(event.data);
    if (message?.type !== "chunk-commit") return;
    pendingCommits.get(`${message.fileId}:${message.chunkIndex}`)?.resolve(message.committedBytes);
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}

export async function sendFiles(
  channel: RTCDataChannel,
  files: File[],
  plan: TransferPlan,
  handlers: SenderRuntimeHandlers,
  progress: ResumeProgress | number,
  shouldContinue: () => boolean,
  onResumeProgress?: (progress: ResumeProgress) => void,
  scheduler?: Partial<TransferSchedulerOptions>,
) {
  const resume = normalizeResumeProgress(plan, coerceResumeProgress(plan, progress));
  const pauseTarget = pauseAfterCompletedFiles();
  const schedulerOptions = pauseTarget === null ? scheduler : { ...scheduler, maxActiveFiles: 1 };
  const pendingCommits = new Map<string, PromiseWithResolvers<number>>();
  const detachCommitListener = attachCommitListener(channel, pendingCommits);

  handlers.onStatus("Transferring");
  try {
    await sendScheduledTransfer(files, {
      handlers,
      mode: "direct",
      onResumeProgress,
      plan,
      progress: resume,
      recordEvent: recordTransferTestEvent,
      scheduler: schedulerOptions,
      shouldContinue,
      shouldPause: (progress) => pauseTarget === completedFilesFromProgress(progress),
      transport: {
        beforeChunk: () => awaitBufferedAmount(channel),
        bufferedBytes: () => channel.bufferedAmount,
        complete: (totalBytes) => sendProtocolMessage(channel, { type: "complete", totalBytes }),
        endFile: (file, bytes, digest) =>
          sendProtocolMessage(channel, { type: "file-end", fileId: file.id, bytes, digest }),
        sendChunk(chunk) {
          const commit = awaitCommit(
            pendingCommits,
            channel,
            chunk.file.id,
            chunk.chunkIndex,
            chunk.offset + chunk.bytes.byteLength,
            shouldContinue,
          );
          // Sync send keeps channel-close failures immediate; pipeline + beforeChunk
          // provides FastSend-style multi-chunk flow under bufferedAmount backpressure.
          sendProtocolMessage(channel, {
            type: "chunk",
            fileId: chunk.file.id,
            chunkIndex: chunk.chunkIndex,
            offset: chunk.offset,
            bytes: chunk.bytes,
            chunkDigest: chunk.chunkDigest,
          });
          return commit;
        },
        sendManifest: (nextPlan) =>
          sendProtocolMessage(channel, {
            type: "manifest",
            files: nextPlan.manifest,
            totalBytes: nextPlan.totalBytes,
            manifestHash: nextPlan.manifestHash,
          }),
        startFile: (file, offset) =>
          sendProtocolMessage(channel, { type: "file-start", file, offset }),
      },
    });
  } finally {
    detachCommitListener();
  }
}

export async function sendFilesViaRelay(
  queue: RelayMessageQueue,
  files: File[],
  plan: TransferPlan,
  handlers: SenderRuntimeHandlers,
  progress: ResumeProgress | number,
  shouldContinue: () => boolean,
  onResumeProgress?: (progress: ResumeProgress) => void,
  scheduler?: Partial<TransferSchedulerOptions>,
) {
  const resume = normalizeResumeProgress(plan, coerceResumeProgress(plan, progress));
  const pauseTarget = pauseAfterCompletedFiles();

  handlers.onMode("relay");
  try {
    await sendScheduledTransfer(files, {
      handlers,
      mode: "relay",
      onResumeProgress,
      plan,
      progress: resume,
      recordEvent: recordTransferTestEvent,
      scheduler,
      shouldContinue,
      shouldPause: (progress) => pauseTarget === completedFilesFromProgress(progress),
      transport: {
        bufferedBytes: () => queue.pendingWireByteLength(),
        complete: (totalBytes) => queue.send({ type: "complete", totalBytes }),
        endFile: (file, bytes, digest) =>
          queue.send({ type: "file-end", fileId: file.id, bytes, digest }),
        async sendChunk(chunk) {
          const commit = queue.awaitCommit(
            chunk.file.id,
            chunk.chunkIndex,
            chunk.offset + chunk.bytes.byteLength,
          );
          // A receiver restart can reset this queue before delivery resolves.
          // Keep the rejection observed until the scheduler awaits the same promise.
          void commit.catch(() => undefined);
          await queue.send({
            type: "chunk",
            fileId: chunk.file.id,
            chunkIndex: chunk.chunkIndex,
            offset: chunk.offset,
            bytes: chunk.bytes,
            chunkDigest: chunk.chunkDigest,
          });
          // Start commit timeout only after delivery ACK so receiver commit latency
          // remains separate from Relay delivery RTT.
          queue.armCommitTimeout(chunk.file.id, chunk.chunkIndex);
          return commit;
        },
        sendManifest: (nextPlan) =>
          queue.send({
            type: "manifest",
            files: nextPlan.manifest,
            totalBytes: nextPlan.totalBytes,
            manifestHash: nextPlan.manifestHash,
          }),
        startFile: (file, offset) => queue.send({ type: "file-start", file, offset }),
      },
    });
  } finally {
    const telemetry = queue.takeTelemetry();
    recordTransferTestEvent({
      type: "relay-delivery-telemetry",
      ...telemetry,
      wireByteAmplification:
        telemetry.originalWireBytes > 0
          ? telemetry.transmittedWireBytes / telemetry.originalWireBytes
          : 1,
    });
  }
}
