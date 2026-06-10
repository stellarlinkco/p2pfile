import type { FileManifestItem } from "@p2pfile/shared";
import type { ReceivedFile, ReceiverRuntimeHandlers } from "./types";

export function manifestFromFiles(files: File[], frozenManifest?: FileManifestItem[]) {
  return (
    frozenManifest?.map((file) => ({ id: file.id, name: file.name, size: file.size })) ??
    files.map((file, index) => ({
      id: `file-${index + 1}`,
      name: file.name,
      size: file.size,
    }))
  );
}

export function createChannelName(sessionId: string) {
  return `p2pfile:test:${sessionId}`;
}

export function restoreProgressState(
  expectedManifest: FileManifestItem[],
  receivedFiles: ReceivedFile[],
  handlers: ReceiverRuntimeHandlers,
) {
  const completedIds = new Set(receivedFiles.map((file) => file.id));
  let completedBytes = 0;
  for (const file of expectedManifest) {
    if (!completedIds.has(file.id)) break;
    completedBytes += file.size;
  }

  const nextFile = expectedManifest[receivedFiles.length] ?? null;
  handlers.onProgress({
    fileId: nextFile?.id ?? null,
    fileName: nextFile?.name ?? null,
    fileBytes: 0,
    fileTotalBytes: nextFile?.size ?? 0,
    completedBytes,
    totalBytes: expectedManifest.reduce((sum, file) => sum + file.size, 0),
    completedFiles: receivedFiles.length,
    totalFiles: expectedManifest.length,
  });
}
