import type { RefObject } from "react";
import type { ReceivedFile, ReceiverRuntime } from "../lib/transfer";

export function revokeReceivedFiles(files: ReceivedFile[]) {
  files.forEach((file) => {
    URL.revokeObjectURL(file.url);
  });
}

export function stopReceiverRuntime(runtimeRef: RefObject<ReceiverRuntime | null>) {
  runtimeRef.current?.stop();
  runtimeRef.current = null;
}

export function clearReceivedFiles(
  receivedFilesRef: RefObject<ReceivedFile[]>,
  setReceivedFiles: (files: ReceivedFile[]) => void,
) {
  revokeReceivedFiles(receivedFilesRef.current);
  receivedFilesRef.current = [];
  setReceivedFiles([]);
}
