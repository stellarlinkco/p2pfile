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
  maxInFlightBytes: MANIFEST_CHUNK_BYTES * 2,
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
  offset: number;
  resumeFile: ResumeProgress["files"][number];
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

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

  const trackCommit = (file: ScheduledFile, chunkBytes: ArrayBuffer, commit: Promise<number>) => {
    const chunkLength = chunkBytes.byteLength;
    inFlightBytes += chunkLength;
    file.inFlightBytes += chunkLength;
    const tracked = commit
      .then(async (committedBytes) => {
        const expectedCommittedBytes = file.offset + chunkLength;
        if (committedBytes !== expectedCommittedBytes) {
          throw new Error("Receiver committed an unexpected chunk offset.");
        }
        file.digest.update(chunkBytes);
        file.offset = committedBytes;
        file.resumeFile.committedBytes = committedBytes;
        options.onResumeProgress?.(options.progress);
        options.recordEvent?.({
          type: `${options.mode}-chunk-commit`,
          fileId: file.manifestItem.id,
          chunkIndex: Math.floor((committedBytes - chunkLength) / MANIFEST_CHUNK_BYTES),
          committedBytes,
          inFlightBytes: inFlightBytes - chunkLength,
        });
        reportProgress(file.manifestItem.id);
        const delay = chunkDelayMs();
        if (delay > 0) await sleep(delay);
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
    const activeCount = activeFiles.length;
    for (let attempt = 0; attempt < activeCount; attempt += 1) {
      const file = activeFiles[cursor % activeFiles.length];
      cursor = (cursor + 1) % Math.max(1, activeFiles.length);
      if (!file || file.inFlightBytes > 0) {
        continue;
      }
      if (file.offset >= file.file.size) {
        paused = await finishFile(file);
        if (paused) break;
        await activateNextFiles();
        madeProgress = true;
        break;
      }

      const nextChunkBytes = Math.min(MANIFEST_CHUNK_BYTES, file.file.size - file.offset);
      if (inFlightBytes + nextChunkBytes > scheduler.maxInFlightBytes) {
        continue;
      }

      await options.transport.beforeChunk?.();
      assertActive();
      const offset = file.offset;
      const bytes = await file.file.slice(offset, offset + MANIFEST_CHUNK_BYTES).arrayBuffer();
      assertActive();
      const chunkIndex = Math.floor(offset / MANIFEST_CHUNK_BYTES);
      const chunkDigest = await sha256Hex(bytes);
      trackCommit(
        file,
        bytes,
        options.transport.sendChunk({
          file: file.manifestItem,
          chunkIndex,
          offset,
          bytes,
          chunkDigest,
        }),
      );
      madeProgress = true;
    }

    if (paused) {
      return;
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
