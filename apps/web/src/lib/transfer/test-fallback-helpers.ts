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
  committedBytesByFileId: ReadonlyMap<string, number> = new Map(
    receivedFiles.map((file) => [file.id, file.size]),
  ),
) {
  const progressFiles = expectedManifest.map((file) => {
    const fileBytes = Math.max(0, Math.min(committedBytesByFileId.get(file.id) ?? 0, file.size));
    const completed =
      fileBytes === file.size && (file.size > 0 || committedBytesByFileId.has(file.id));
    return { file, fileBytes, completed };
  });
  const next = progressFiles.find((file) => !file.completed) ?? null;

  handlers.onProgress({
    fileId: next?.file.id ?? null,
    fileName: next?.file.name ?? null,
    fileBytes: next?.fileBytes ?? 0,
    fileTotalBytes: next?.file.size ?? 0,
    completedBytes: progressFiles.reduce((sum, file) => sum + file.fileBytes, 0),
    totalBytes: expectedManifest.reduce((sum, file) => sum + file.size, 0),
    completedFiles: progressFiles.filter((file) => file.completed).length,
    totalFiles: expectedManifest.length,
    files: progressFiles.map(({ file, fileBytes, completed }) => ({
      fileId: file.id,
      fileName: file.name,
      fileBytes,
      fileTotalBytes: file.size,
      state: completed ? "completed" : fileBytes > 0 ? "reconnecting" : "queued",
    })),
  });
}
