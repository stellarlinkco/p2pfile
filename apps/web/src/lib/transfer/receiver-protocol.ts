import type { FileManifestItem } from "@p2pfile/shared";
import { createSha256Digest, type Sha256Digest } from "./digest";
import type { ReceiverRuntimeHandlers, TransferProtocolMessage } from "./types";

export type ReceiverProtocolState = {
  manifest: FileManifestItem[];
  totalBytes: number;
  completedBytes: number;
  receivedFiles: number;
  currentFile: FileManifestItem | null;
  currentChunks: ArrayBuffer[];
  currentDigest: Sha256Digest | null;
  currentBytes: number;
  failed: boolean;
};

export function buildReceiverState(expectedManifest: FileManifestItem[]): ReceiverProtocolState {
  return {
    manifest: expectedManifest,
    totalBytes: expectedManifest.reduce((sum, file) => sum + file.size, 0),
    completedBytes: 0,
    receivedFiles: 0,
    currentFile: null,
    currentChunks: [],
    currentDigest: null,
    currentBytes: 0,
    failed: false,
  };
}
function manifestMatchesExpected(expected: FileManifestItem[], received: FileManifestItem[]) {
  if (expected.length !== received.length) {
    return false;
  }

  return expected.every((file, index) => {
    const next = received[index];
    return next?.id === file.id && next.name === file.name && next.size === file.size;
  });
}

function failReceiverState(state: ReceiverProtocolState, message: string): never {
  state.failed = true;
  state.currentFile = null;
  state.currentChunks = [];
  state.currentDigest = null;
  state.currentBytes = 0;
  throw new Error(message);
}
export async function handleProtocolMessage(
  message: TransferProtocolMessage,
  state: ReceiverProtocolState,
  handlers: ReceiverRuntimeHandlers,
) {
  if (state.failed) {
    return;
  }

  if (message.type === "manifest") {
    if (
      message.totalBytes !== state.totalBytes ||
      !manifestMatchesExpected(state.manifest, message.files)
    ) {
      failReceiverState(state, "Session manifest verification failed.");
    }
    handlers.onStatus("Receiving manifest");
    return;
  }

  if (message.type === "file-start") {
    const expectedFile = state.manifest[state.receivedFiles];
    if (
      !expectedFile ||
      message.file.id !== expectedFile.id ||
      message.file.name !== expectedFile.name ||
      message.file.size !== expectedFile.size
    ) {
      failReceiverState(state, "Sender sent files out of order.");
    }
    state.currentFile = message.file;
    state.currentChunks = [];
    state.currentDigest = createSha256Digest();
    state.currentBytes = 0;
    handlers.onStatus(`Receiving ${message.file.name}`);
    return;
  }

  if (message.type === "chunk") {
    if (!state.currentFile || message.fileId !== state.currentFile.id) {
      failReceiverState(state, "Sender sent a chunk for the wrong file.");
    }
    state.currentChunks.push(message.bytes);
    state.currentDigest?.update(message.bytes);
    state.currentBytes += message.bytes.byteLength;
    handlers.onProgress({
      fileId: state.currentFile ? state.currentFile.id : message.fileId,
      fileName: state.currentFile ? state.currentFile.name : null,
      fileBytes: state.currentBytes,
      fileTotalBytes: state.currentFile ? state.currentFile.size : 0,
      completedBytes: state.completedBytes + state.currentBytes,
      totalBytes: state.totalBytes,
      completedFiles: state.receivedFiles,
      totalFiles: state.manifest.length,
    });
    return;
  }

  if (message.type === "file-end") {
    if (
      !state.currentFile ||
      message.fileId !== state.currentFile.id ||
      state.currentBytes !== message.bytes ||
      state.currentBytes !== state.currentFile.size
    ) {
      failReceiverState(state, "File size verification failed.");
    }

    const digest = state.currentDigest?.digestHex();
    if (digest !== message.digest) {
      failReceiverState(state, "File integrity verification failed.");
    }

    const blob = new Blob(state.currentChunks);
    state.completedBytes += state.currentBytes;
    state.receivedFiles += 1;
    handlers.onProgress({
      fileId: state.currentFile.id,
      fileName: state.currentFile.name,
      fileBytes: state.currentFile.size,
      fileTotalBytes: state.currentFile.size,
      completedBytes: state.completedBytes,
      totalBytes: state.totalBytes,
      completedFiles: state.receivedFiles,
      totalFiles: state.manifest.length,
    });
    handlers.onFileReceived({
      id: state.currentFile.id,
      name: state.currentFile.name,
      size: state.currentFile.size,
      blob,
      url: URL.createObjectURL(blob),
    });
    state.currentFile = null;
    state.currentChunks = [];
    state.currentDigest = null;
    state.currentBytes = 0;
    return;
  }

  if (
    state.receivedFiles !== state.manifest.length ||
    state.completedBytes !== message.totalBytes ||
    state.completedBytes !== state.totalBytes
  ) {
    failReceiverState(state, "Session size verification failed.");
  }

  handlers.onComplete();
}
