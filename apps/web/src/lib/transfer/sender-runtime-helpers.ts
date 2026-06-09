import type { RelayMessageQueue } from "./relay-queue";
import { awaitBufferedAmount, sendProtocolMessage } from "./runtime-shared";
import type { SenderRuntimeHandlers, TransferProgress } from "./types";

export type TransferPlan = {
  manifest: Array<{ id: string; name: string; size: number }>;
  totalBytes: number;
};

export function manifestFromFiles(files: File[]) {
  return files.map((file, index) => ({
    id: `file-${index + 1}`,
    name: file.name,
    size: file.size,
  }));
}

export function buildTransferPlan(files: File[]): TransferPlan {
  const manifest = manifestFromFiles(files);
  return { manifest, totalBytes: manifest.reduce((sum, file) => sum + file.size, 0) };
}

function completedBytesFor(plan: TransferPlan, completedFiles: number) {
  return plan.manifest.slice(0, completedFiles).reduce((sum, file) => sum + file.size, 0);
}

export function reportResumeProgress(
  plan: TransferPlan,
  completedFiles: number,
  handlers: SenderRuntimeHandlers,
) {
  const nextFile = plan.manifest[completedFiles] ?? null;
  handlers.onProgress({
    fileId: nextFile?.id ?? null,
    fileName: nextFile?.name ?? null,
    fileBytes: 0,
    fileTotalBytes: nextFile?.size ?? 0,
    completedBytes: completedBytesFor(plan, completedFiles),
    totalBytes: plan.totalBytes,
    completedFiles,
    totalFiles: plan.manifest.length,
  } satisfies TransferProgress);
}

export function assertTransferActive(shouldContinue: () => boolean) {
  if (!shouldContinue()) {
    throw new Error("Transfer restarted.");
  }
}

export async function sendFiles(
  channel: RTCDataChannel,
  files: File[],
  plan: TransferPlan,
  handlers: SenderRuntimeHandlers,
  startIndex: number,
  shouldContinue: () => boolean,
) {
  let completedBytes = completedBytesFor(plan, startIndex);
  let completedFiles = startIndex;

  handlers.onStatus("Transferring");
  sendProtocolMessage(channel, {
    type: "manifest",
    files: plan.manifest,
    totalBytes: plan.totalBytes,
  });

  for (let index = startIndex; index < files.length; index += 1) {
    assertTransferActive(shouldContinue);
    const file = files[index];
    const manifestItem = plan.manifest[index];
    if (!file || !manifestItem) {
      continue;
    }

    let fileBytes = 0;
    sendProtocolMessage(channel, { type: "file-start", file: manifestItem });

    for (let offset = 0; offset < file.size; offset += 64 * 1024) {
      assertTransferActive(shouldContinue);
      await awaitBufferedAmount(channel);
      assertTransferActive(shouldContinue);
      const bytes = await file.slice(offset, offset + 64 * 1024).arrayBuffer();
      assertTransferActive(shouldContinue);
      channel.send(bytes);
      fileBytes += bytes.byteLength;
      handlers.onProgress({
        fileId: manifestItem.id,
        fileName: manifestItem.name,
        fileBytes,
        fileTotalBytes: manifestItem.size,
        completedBytes: completedBytes + fileBytes,
        totalBytes: plan.totalBytes,
        completedFiles,
        totalFiles: files.length,
      } satisfies TransferProgress);
    }

    assertTransferActive(shouldContinue);
    sendProtocolMessage(channel, { type: "file-end", fileId: manifestItem.id, bytes: fileBytes });
    completedBytes += fileBytes;
    completedFiles += 1;
  }

  assertTransferActive(shouldContinue);
  sendProtocolMessage(channel, { type: "complete", totalBytes: plan.totalBytes });
}

export async function sendFilesViaRelay(
  queue: RelayMessageQueue,
  files: File[],
  plan: TransferPlan,
  handlers: SenderRuntimeHandlers,
  startIndex: number,
  shouldContinue: () => boolean,
) {
  let completedBytes = completedBytesFor(plan, startIndex);
  let completedFiles = startIndex;

  handlers.onMode("relay");
  await queue.send({ type: "manifest", files: plan.manifest, totalBytes: plan.totalBytes });

  for (let index = startIndex; index < files.length; index += 1) {
    assertTransferActive(shouldContinue);
    const file = files[index];
    const manifestItem = plan.manifest[index];
    if (!file || !manifestItem) {
      continue;
    }

    let fileBytes = 0;
    await queue.send({ type: "file-start", file: manifestItem });

    for (let offset = 0; offset < file.size; offset += 64 * 1024) {
      assertTransferActive(shouldContinue);
      const bytes = await file.slice(offset, offset + 64 * 1024).arrayBuffer();
      assertTransferActive(shouldContinue);
      await queue.send({ type: "chunk", fileId: manifestItem.id, bytes });
      fileBytes += bytes.byteLength;
      handlers.onProgress({
        fileId: manifestItem.id,
        fileName: manifestItem.name,
        fileBytes,
        fileTotalBytes: manifestItem.size,
        completedBytes: completedBytes + fileBytes,
        totalBytes: plan.totalBytes,
        completedFiles,
        totalFiles: files.length,
      } satisfies TransferProgress);
    }

    assertTransferActive(shouldContinue);
    await queue.send({ type: "file-end", fileId: manifestItem.id, bytes: fileBytes });
    completedBytes += fileBytes;
    completedFiles += 1;
  }

  assertTransferActive(shouldContinue);
  await queue.send({ type: "complete", totalBytes: plan.totalBytes });
}
