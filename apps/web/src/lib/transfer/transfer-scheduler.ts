import { type FileManifestItem, MANIFEST_CHUNK_BYTES, type ResumeProgress } from "@p2pfile/shared";
import { createSha256Digest, type Sha256Digest } from "./digest";
import type {
  SenderRuntimeHandlers,
  TransferFileProgress,
  TransferFileState,
  TransferProgress,
} from "./types";

export type TransferSchedulerOptions = {
  maxActiveFiles: number;
  maxInFlightBytes: number;
};

export const DEFAULT_TRANSFER_SCHEDULER: TransferSchedulerOptions = {
  maxActiveFiles: 2,
  // 16 chunks × 64 KiB = 1 MiB pipeline window. Keeps resume semantics while
  // removing the single-chunk RTT ceiling for large files.
  maxInFlightBytes: MANIFEST_CHUNK_BYTES * 16,
};

type TransferPlan = {
  manifest: FileManifestItem[];
  manifestHash: string;
  totalBytes: number;
};

type ScheduledChunk = {
  file: FileManifestItem;
  chunkIndex: number;
  offset: number;
  bytes: ArrayBuffer;
  chunkDigest: string;
};

type ScheduledTransport = {
  beforeChunk?: () => Promise<void> | void;
  complete: (totalBytes: number) => Promise<void> | void;
  endFile: (file: FileManifestItem, bytes: number, digest: string) => Promise<void> | void;
  sendChunk: (chunk: ScheduledChunk) => Promise<number>;
  sendManifest: (plan: TransferPlan) => Promise<void> | void;
  startFile: (file: FileManifestItem, offset: number) => Promise<void> | void;
};

type ScheduledFile = {
  digest: Sha256Digest;
  file: File;
  index: number;
  inFlightBytes: number;
  manifestItem: FileManifestItem;
  /** Durable cursor advanced only by ordered receiver commits. */
  offset: number;
  resumeFile: ResumeProgress["files"][number];
  /** Send cursor; may lead offset while chunks are in flight. */
  sentOffset: number;
  started: boolean;
};

type SendScheduledTransferOptions = {
  handlers: SenderRuntimeHandlers;
  mode: "direct" | "relay";
  onResumeProgress?: (progress: ResumeProgress) => void;
  plan: TransferPlan;
  progress: ResumeProgress;
  recordEvent?: (event: Record<string, unknown>) => void;
  scheduler?: Partial<TransferSchedulerOptions>;
  shouldContinue: () => boolean;
  shouldPause?: (progress: ResumeProgress) => boolean;
  transport: ScheduledTransport;
};

function normalizeSchedulerOptions(options?: Partial<TransferSchedulerOptions>) {
  return {
    maxActiveFiles: Math.max(
      1,
      Math.floor(options?.maxActiveFiles ?? DEFAULT_TRANSFER_SCHEDULER.maxActiveFiles),
    ),
    maxInFlightBytes: Math.max(
      MANIFEST_CHUNK_BYTES,
      Math.floor(options?.maxInFlightBytes ?? DEFAULT_TRANSFER_SCHEDULER.maxInFlightBytes),
    ),
  } satisfies TransferSchedulerOptions;
}

function completedBytesFor(progress: ResumeProgress) {
  return progress.files.reduce((sum, file) => sum + file.committedBytes, 0);
}

function completedFilesFor(progress: ResumeProgress) {
  return progress.files.filter((file) => file.completed).length;
}

export function progressFilesFromResume(
  plan: TransferPlan,
  progress: ResumeProgress,
  activeFileIds: ReadonlySet<string> = new Set(),
  overrides: ReadonlyMap<string, TransferFileState> = new Map(),
) {
  return plan.manifest.map((file, index) => {
    const fileProgress = progress.files[index];
    const overrideState = overrides.get(file.id);
    const state =
      overrideState ??
      (fileProgress?.completed
        ? "completed"
        : activeFileIds.has(file.id)
          ? "receiving"
          : fileProgress && fileProgress.committedBytes > 0
            ? "reconnecting"
            : "queued");
    return {
      fileId: file.id,
      fileName: file.name,
      fileBytes: fileProgress?.committedBytes ?? 0,
      fileTotalBytes: file.size,
      state,
    } satisfies TransferFileProgress;
  });
}

export function buildTransferProgress(
  plan: TransferPlan,
  progress: ResumeProgress,
  currentFileId: string | null,
  activeFileIds: ReadonlySet<string> = new Set(),
  overrides: ReadonlyMap<string, TransferFileState> = new Map(),
) {
  const currentIndex = currentFileId
    ? plan.manifest.findIndex((file) => file.id === currentFileId)
    : plan.manifest.findIndex((_, index) => !progress.files[index]?.completed);
  const currentFile = currentIndex >= 0 ? plan.manifest[currentIndex] : null;
  const currentProgress = currentIndex >= 0 ? progress.files[currentIndex] : null;
  return {
    fileId: currentFile?.id ?? null,
    fileName: currentFile?.name ?? null,
    fileBytes: currentProgress?.committedBytes ?? 0,
    fileTotalBytes: currentFile?.size ?? 0,
    completedBytes: completedBytesFor(progress),
    totalBytes: plan.totalBytes,
    completedFiles: completedFilesFor(progress),
    totalFiles: plan.manifest.length,
    files: progressFilesFromResume(plan, progress, activeFileIds, overrides),
  } satisfies TransferProgress;
}

function sha256Hex(bytes: ArrayBuffer) {
  const digest = createSha256Digest();
  digest.update(bytes);
  return digest.digestHex();
}

function sleep(milliseconds: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  globalThis.setTimeout(resolve, milliseconds);
  return promise;
}

function chunkDelayMs() {
  const value = (globalThis as { __P2PFILE_TEST_CHUNK_DELAY_MS__?: number })
    .__P2PFILE_TEST_CHUNK_DELAY_MS__;
  return typeof value === "number" && value > 0 ? value : 0;
}

export function markProgressFiles(
  progress: TransferProgress,
  from: TransferFileState,
  to: TransferFileState,
) {
  return {
    ...progress,
    files: progress.files?.map((file) => ({
      ...file,
      state: file.state === from ? to : file.state,
    })),
  } satisfies TransferProgress;
}

export async function sendScheduledTransfer(files: File[], options: SendScheduledTransferOptions) {
  const scheduler = normalizeSchedulerOptions(options.scheduler);
  const activeFiles: ScheduledFile[] = [];
  const activeFileIds = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let nextFileIndex = 0;
  let cursor = 0;
  let inFlightBytes = 0;

  const assertActive = () => {
    if (!options.shouldContinue()) throw new Error("Transfer restarted.");
  };

  const reportProgress = (currentFileId: string | null) => {
    options.handlers.onProgress(
      buildTransferProgress(options.plan, options.progress, currentFileId, activeFileIds),
    );
  };

  const activateNextFiles = async () => {
    while (activeFiles.length < scheduler.maxActiveFiles && nextFileIndex < files.length) {
      const index = nextFileIndex;
      nextFileIndex += 1;
      const file = files[index];
      const manifestItem = options.plan.manifest[index];
      const resumeFile = options.progress.files[index];
      if (!file || !manifestItem || !resumeFile || resumeFile.completed) {
        continue;
      }

      assertActive();
      const digest = createSha256Digest();
      const offset = resumeFile.committedBytes;
      if (offset > 0) digest.update(await file.slice(0, offset).arrayBuffer());
      await options.transport.startFile(manifestItem, offset);
      options.recordEvent?.({
        type: `${options.mode}-file-start`,
        fileId: manifestItem.id,
        offset,
      });
      const scheduled = {
        digest,
        file,
        index,
        inFlightBytes: 0,
        manifestItem,
        offset,
        resumeFile,
        sentOffset: offset,
        started: true,
      } satisfies ScheduledFile;
      activeFiles.push(scheduled);
      activeFileIds.add(manifestItem.id);
      reportProgress(manifestItem.id);
    }
  };

  const finishFile = async (file: ScheduledFile) => {
    assertActive();
    await options.transport.endFile(file.manifestItem, file.offset, file.digest.digestHex());
    file.resumeFile.completed = true;
    file.resumeFile.committedBytes = file.manifestItem.size;
    options.onResumeProgress?.(options.progress);
    options.recordEvent?.({
      type: `${options.mode}-file-complete`,
      fileId: file.manifestItem.id,
      bytes: file.manifestItem.size,
    });
    activeFileIds.delete(file.manifestItem.id);
    const index = activeFiles.indexOf(file);
    if (index >= 0) activeFiles.splice(index, 1);
    if (cursor > index && cursor > 0) cursor -= 1;
    reportProgress(file.manifestItem.id);
    const delay = chunkDelayMs();
    if (delay > 0) await sleep(delay);
    return options.shouldPause?.(options.progress) === true;
  };

  const pendingCommitsByFile = new Map<
    string,
    Map<number, { bytes: ArrayBuffer; length: number }>
  >();
  const applyChains = new Map<string, Promise<void>>();

  const applyCommittedChunks = async (file: ScheduledFile) => {
    const pending = pendingCommitsByFile.get(file.manifestItem.id);
    if (!pending) return;

    while (true) {
      const next = pending.get(file.offset);
      if (!next) return;
      pending.delete(file.offset);
      file.digest.update(next.bytes);
      file.offset += next.length;
      file.resumeFile.committedBytes = file.offset;
      options.onResumeProgress?.(options.progress);
      options.recordEvent?.({
        type: `${options.mode}-chunk-commit`,
        fileId: file.manifestItem.id,
        chunkIndex: Math.floor((file.offset - next.length) / MANIFEST_CHUNK_BYTES),
        committedBytes: file.offset,
        inFlightBytes: Math.max(0, inFlightBytes - next.length),
      });
      reportProgress(file.manifestItem.id);
      const delay = chunkDelayMs();
      if (delay > 0) await sleep(delay);
    }
  };

  const enqueueCommitApplication = (file: ScheduledFile) => {
    const key = file.manifestItem.id;
    const previous = applyChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => applyCommittedChunks(file))
      .finally(() => {
        if (applyChains.get(key) === next) {
          applyChains.delete(key);
        }
      });
    applyChains.set(key, next);
    return next;
  };

  const trackCommit = (
    file: ScheduledFile,
    chunkBytes: ArrayBuffer,
    chunkOffset: number,
    commit: Promise<number>,
  ) => {
    const chunkLength = chunkBytes.byteLength;
    const expectedCommittedBytes = chunkOffset + chunkLength;
    inFlightBytes += chunkLength;
    file.inFlightBytes += chunkLength;
    const tracked = commit
      .then(async (committedBytes) => {
        if (committedBytes !== expectedCommittedBytes) {
          throw new Error("Receiver committed an unexpected chunk offset.");
        }
        const pending =
          pendingCommitsByFile.get(file.manifestItem.id) ??
          new Map<number, { bytes: ArrayBuffer; length: number }>();
        pending.set(chunkOffset, { bytes: chunkBytes, length: chunkLength });
        pendingCommitsByFile.set(file.manifestItem.id, pending);
        await enqueueCommitApplication(file);
        if (pending.size === 0) {
          pendingCommitsByFile.delete(file.manifestItem.id);
        }
      })
      .catch((error) => {
        if (error instanceof Error && error.message === "Transfer restarted.") {
          return;
        }
        throw error;
      })
      .finally(() => {
        inFlightBytes -= chunkLength;
        file.inFlightBytes -= chunkLength;
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  await options.transport.sendManifest(options.plan);
  await activateNextFiles();

  let paused = false;
  while (activeFiles.length > 0 || nextFileIndex < files.length || inFlight.size > 0) {
    assertActive();
    await activateNextFiles();

    let madeProgress = false;

    for (const completed of [...activeFiles].filter((file) => file.offset >= file.file.size)) {
      if (!activeFiles.includes(completed)) continue;
      paused = await finishFile(completed);
      if (paused) break;
      await activateNextFiles();
      madeProgress = true;
    }
    if (paused) {
      return;
    }

    const sendable = activeFiles.filter((file) => file.sentOffset < file.file.size);
    const preferred = sendable.filter((file) => file.inFlightBytes === 0);
    const candidates = preferred.length > 0 ? preferred : sendable;

    // Fill the global window. Prefer files with no outstanding commits so
    // newly activated small files are not starved by a pipelined large file.
    let sentThisPass = 0;
    while (candidates.length > 0) {
      const file = candidates[cursor % candidates.length];
      cursor = (cursor + 1) % Math.max(1, candidates.length);
      if (!file) {
        break;
      }
      if (file.sentOffset >= file.file.size) {
        const index = candidates.indexOf(file);
        if (index >= 0) candidates.splice(index, 1);
        if (candidates.length === 0) break;
        continue;
      }

      const nextChunkBytes = Math.min(MANIFEST_CHUNK_BYTES, file.file.size - file.sentOffset);
      if (inFlightBytes + nextChunkBytes > scheduler.maxInFlightBytes) {
        break;
      }

      await options.transport.beforeChunk?.();
      assertActive();
      const offset = file.sentOffset;
      const bytes = await file.file.slice(offset, offset + MANIFEST_CHUNK_BYTES).arrayBuffer();
      assertActive();
      const chunkIndex = Math.floor(offset / MANIFEST_CHUNK_BYTES);
      const chunkDigest = await sha256Hex(bytes);
      file.sentOffset = offset + bytes.byteLength;
      trackCommit(
        file,
        bytes,
        offset,
        options.transport.sendChunk({
          file: file.manifestItem,
          chunkIndex,
          offset,
          bytes,
          chunkDigest,
        }),
      );
      madeProgress = true;
      sentThisPass += 1;

      // After giving a zero-inflight file its first chunk, rebuild preference
      // so other zero-inflight files still get a slot before deeper pipeline.
      if (preferred.includes(file) && preferred.length > 1 && sentThisPass >= preferred.length) {
        break;
      }
      if (file.sentOffset >= file.file.size) {
        const index = candidates.indexOf(file);
        if (index >= 0) candidates.splice(index, 1);
      }
      if (candidates.length === 0) break;
    }

    if (madeProgress) {
      continue;
    }
    if (inFlight.size === 0) {
      break;
    }
    await Promise.race(inFlight);
  }

  if (inFlight.size > 0) {
    await Promise.all(inFlight);
  }
  assertActive();
  await options.transport.complete(options.plan.totalBytes);
}
