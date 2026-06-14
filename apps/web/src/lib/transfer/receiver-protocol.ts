import {
  type FileManifestItem,
  MANIFEST_CHUNK_BYTES,
  manifestHash,
  resumeProgressFromManifest,
} from "@p2pfile/shared";
import { createSha256Digest, type Sha256Digest } from "./digest";
import type {
  ReceivedFile,
  ReceiverRuntimeHandlers,
  TransferFileProgress,
  TransferFileState,
  TransferProtocolMessage,
} from "./types";

const SMALL_FILE_BLOB_LIMIT = 1024 * 1024;
const SINK_READ_CHUNK_BYTES = MANIFEST_CHUNK_BYTES;

type ReceiverSink = {
  readonly committedBytes: number;
  write: (offset: number, bytes: ArrayBuffer, file: FileManifestItem) => Promise<void>;
  updateDigest: (
    offset: number,
    length: number,
    file: FileManifestItem,
    digest: Sha256Digest,
  ) => Promise<number>;
  finalize: (file: FileManifestItem) => Promise<ReceivedFile>;
  reset: () => void;
};

class MemoryBlobSink implements ReceiverSink {
  private readonly chunks = new Map<number, ArrayBuffer>();
  committedBytes = 0;

  async write(offset: number, bytes: ArrayBuffer) {
    this.chunks.set(offset, bytes.slice(0));
    this.committedBytes = offset + bytes.byteLength;
  }

  async read(offset: number, length: number) {
    const chunks = [...this.chunks.entries()].sort(([left], [right]) => left - right);
    const result = new Uint8Array(length);
    let copied = 0;
    for (const [chunkOffset, bytes] of chunks) {
      if (copied >= length) break;
      if (chunkOffset + bytes.byteLength <= offset) continue;
      if (chunkOffset > offset + copied) break;
      const start = Math.max(0, offset + copied - chunkOffset);
      const available = Math.min(bytes.byteLength - start, length - copied);
      result.set(new Uint8Array(bytes, start, available), copied);
      copied += available;
    }
    return copied === length ? result.buffer : new ArrayBuffer(0);
  }
  async updateDigest(
    offset: number,
    length: number,
    _file: FileManifestItem,
    digest: Sha256Digest,
  ) {
    let readBytes = 0;
    while (readBytes < length) {
      const chunkLength = Math.min(SINK_READ_CHUNK_BYTES, length - readBytes);
      const bytes = await this.read(offset + readBytes, chunkLength);
      if (bytes.byteLength === 0) break;
      digest.update(bytes);
      readBytes += bytes.byteLength;
      if (bytes.byteLength < chunkLength) break;
    }
    return readBytes;
  }

  async finalize(file: FileManifestItem) {
    const chunks = [...this.chunks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, bytes]) => bytes);
    const blob = new Blob(chunks, { type: file.mimeType });
    return { id: file.id, name: file.name, size: file.size, blob, url: URL.createObjectURL(blob) };
  }

  reset() {
    this.chunks.clear();
    this.committedBytes = 0;
  }
}

class OpfsSink implements ReceiverSink {
  private filePromise: Promise<FileSystemFileHandle> | null = null;
  committedBytes = 0;

  constructor(private readonly sessionId: string) {}

  private file(file: FileManifestItem) {
    this.filePromise ??= navigator.storage.getDirectory().then((root) =>
      root.getFileHandle(`p2pfile-${this.sessionId}-${file.id}-${file.size}.part`, {
        create: true,
      }),
    );
    return this.filePromise;
  }

  async write(offset: number, bytes: ArrayBuffer, file: FileManifestItem) {
    const handle = await this.file(file);
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.write({ type: "write", position: offset, data: bytes });
    await writable.close();
    this.committedBytes = offset + bytes.byteLength;
  }

  async updateDigest(offset: number, length: number, file: FileManifestItem, digest: Sha256Digest) {
    const blob = await (await this.file(file)).getFile();
    let readBytes = 0;
    while (readBytes < length) {
      const chunkLength = Math.min(SINK_READ_CHUNK_BYTES, length - readBytes);
      const bytes = await blob
        .slice(offset + readBytes, offset + readBytes + chunkLength)
        .arrayBuffer();
      if (bytes.byteLength === 0) break;
      digest.update(bytes);
      readBytes += bytes.byteLength;
      if (bytes.byteLength < chunkLength) break;
    }
    return readBytes;
  }

  async finalize(file: FileManifestItem) {
    const blob = await (await this.file(file)).getFile();
    return { id: file.id, name: file.name, size: file.size, blob, url: URL.createObjectURL(blob) };
  }

  reset() {
    this.committedBytes = 0;
  }
}

type ReceiverFileContext = {
  bytes: number;
  chunkIndex: number;
  completedFile: ReceivedFile | null;
  digest: Sha256Digest | null;
  file: FileManifestItem;
  sink: ReceiverSink | null;
  state: TransferFileState;
};

export type ReceiverProtocolState = {
  manifest: FileManifestItem[];
  manifestHash: string;
  totalBytes: number;
  completedBytes: number;
  receivedFiles: number;
  currentFile: FileManifestItem | null;
  currentDigest: Sha256Digest | null;
  currentBytes: number;
  currentChunkIndex: number;
  sink: ReceiverSink | null;
  committedBytesByFileId: Map<string, number>;
  fileStates: Map<string, ReceiverFileContext>;
  sessionId: string;
  failed: boolean;
};

function completedFromCommitted(file: FileManifestItem, committedBytes: number, hasEntry: boolean) {
  return committedBytes === file.size && (file.size > 0 || hasEntry);
}

export function buildReceiverState(
  expectedManifest: FileManifestItem[],
  committedBytesByFileId: ReadonlyMap<string, number> = new Map(),
  sessionId = "default",
): ReceiverProtocolState {
  const committed = new Map<string, number>();
  const fileStates = new Map<string, ReceiverFileContext>();
  let completedBytes = 0;
  let receivedFiles = 0;
  let currentBytes = 0;
  let currentChunkIndex = 0;
  let legacyCursorFound = false;
  let leadingFilesComplete = true;

  for (const file of expectedManifest) {
    const rawCommittedBytes = committedBytesByFileId.get(file.id) ?? 0;
    const boundedCommittedBytes = Math.max(0, Math.min(rawCommittedBytes, file.size));
    const hasCommittedEntry = committedBytesByFileId.has(file.id);
    const completed = completedFromCommitted(file, boundedCommittedBytes, hasCommittedEntry);
    committed.set(file.id, boundedCommittedBytes);
    if (completed) {
      completedBytes += file.size;
      receivedFiles += 1;
    }
    if (!legacyCursorFound && leadingFilesComplete && !completed) {
      currentBytes = boundedCommittedBytes;
      currentChunkIndex = Math.floor(currentBytes / MANIFEST_CHUNK_BYTES);
      legacyCursorFound = true;
    }
    leadingFilesComplete = leadingFilesComplete && completed;
    fileStates.set(file.id, {
      bytes: boundedCommittedBytes,
      chunkIndex: Math.floor(boundedCommittedBytes / MANIFEST_CHUNK_BYTES),
      completedFile: null,
      digest: null,
      file,
      sink: null,
      state: completed ? "completed" : boundedCommittedBytes > 0 ? "reconnecting" : "queued",
    });
  }

  return {
    manifest: expectedManifest,
    manifestHash: manifestHash(expectedManifest),
    totalBytes: expectedManifest.reduce((sum, file) => sum + file.size, 0),
    completedBytes,
    receivedFiles,
    currentFile: null,
    currentDigest: null,
    currentBytes,
    currentChunkIndex,
    sink: null,
    committedBytesByFileId: committed,
    fileStates,
    sessionId,
    failed: false,
  };
}

function manifestMatchesExpected(expected: FileManifestItem[], received: FileManifestItem[]) {
  if (expected.length !== received.length) return false;
  return expected.every((file, index) => {
    const next = received[index];
    return next?.id === file.id && next.name === file.name && next.size === file.size;
  });
}

function canUseOpfs() {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

function createSink(file: FileManifestItem, sessionId: string): ReceiverSink {
  if (file.size <= SMALL_FILE_BLOB_LIMIT) return new MemoryBlobSink();
  if (canUseOpfs()) return new OpfsSink(sessionId);
  throw new Error("Large-file receiver storage unavailable.");
}

function syncLegacyCurrent(state: ReceiverProtocolState, context: ReceiverFileContext | null) {
  state.currentFile = context?.file ?? null;
  state.currentDigest = context?.digest ?? null;
  state.currentBytes = context?.bytes ?? 0;
  state.currentChunkIndex = context?.chunkIndex ?? 0;
  state.sink = context?.sink ?? null;
}

function recomputeCompletionTotals(state: ReceiverProtocolState) {
  let completedBytes = 0;
  let receivedFiles = 0;
  for (const context of state.fileStates.values()) {
    if (context.state !== "completed") continue;
    completedBytes += context.file.size;
    receivedFiles += 1;
  }
  state.completedBytes = completedBytes;
  state.receivedFiles = receivedFiles;
}

function failReceiverState(state: ReceiverProtocolState, message: string): never {
  state.failed = true;
  for (const context of state.fileStates.values()) {
    if (context.state !== "completed") {
      context.state = "failed";
      context.digest = null;
      context.sink?.reset();
      context.sink = null;
    }
  }
  state.currentFile = null;
  state.currentDigest = null;
  state.currentBytes = 0;
  state.currentChunkIndex = 0;
  state.sink = null;
  throw new Error(message);
}

async function digestHex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ProtocolOptions = {
  onChunkCommit?: (ack: Extract<TransferProtocolMessage, { type: "chunk-commit" }>) => void;
};

function progressFiles(state: ReceiverProtocolState) {
  return state.manifest.map((file) => {
    const context = state.fileStates.get(file.id);
    return {
      fileId: file.id,
      fileName: file.name,
      fileBytes: context?.bytes ?? 0,
      fileTotalBytes: file.size,
      state: context?.state ?? "queued",
    } satisfies TransferFileProgress;
  });
}

function emitProgress(
  state: ReceiverProtocolState,
  handlers: ReceiverRuntimeHandlers,
  currentFile: FileManifestItem | null,
) {
  const currentContext = currentFile ? state.fileStates.get(currentFile.id) : null;
  const committedBytes = [...state.fileStates.values()].reduce((sum, file) => sum + file.bytes, 0);
  handlers.onProgress({
    fileId: currentFile?.id ?? null,
    fileName: currentFile?.name ?? null,
    fileBytes: currentContext?.bytes ?? 0,
    fileTotalBytes: currentFile?.size ?? 0,
    completedBytes: committedBytes,
    totalBytes: state.totalBytes,
    completedFiles: state.receivedFiles,
    totalFiles: state.manifest.length,
    files: progressFiles(state),
  });
}

function resumeProgressFromState(state: ReceiverProtocolState) {
  return resumeProgressFromManifest(state.manifest, state.committedBytesByFileId);
}

export async function handleProtocolMessage(
  message: TransferProtocolMessage,
  state: ReceiverProtocolState,
  handlers: ReceiverRuntimeHandlers,
  options: ProtocolOptions = {},
) {
  if (state.failed || message.type === "chunk-commit") return;

  if (message.type === "manifest") {
    if (
      message.totalBytes !== state.totalBytes ||
      ("manifestHash" in message && message.manifestHash !== state.manifestHash) ||
      !manifestMatchesExpected(state.manifest, message.files)
    ) {
      failReceiverState(state, "Session manifest verification failed.");
    }
    handlers.onStatus("Receiving manifest");
    return;
  }

  if (message.type === "file-start") {
    const context = state.fileStates.get(message.file.id);
    if (
      !context ||
      message.file.name !== context.file.name ||
      message.file.size !== context.file.size
    ) {
      failReceiverState(state, "Sender sent files out of order.");
    }
    const fileIndex = state.manifest.findIndex((file) => file.id === context.file.id);
    for (const priorFile of state.manifest.slice(0, fileIndex)) {
      const priorState = state.fileStates.get(priorFile.id)?.state;
      if (priorState !== "receiving" && priorState !== "completed") {
        failReceiverState(state, "Sender sent files out of order.");
      }
    }
    if (context.state === "completed") {
      return;
    }
    if (message.offset !== context.bytes) {
      failReceiverState(state, "Sender resumed from the wrong offset.");
    }
    const existingSink = context.sink;
    const digest = createSha256Digest();
    context.digest = digest;
    context.chunkIndex = Math.floor(message.offset / MANIFEST_CHUNK_BYTES);
    context.sink = existingSink ?? createSink(message.file, state.sessionId);
    context.state = "receiving";
    if (message.offset > 0) {
      const committedBytes = await context.sink.updateDigest(
        0,
        message.offset,
        message.file,
        digest,
      );
      if (committedBytes !== message.offset) {
        failReceiverState(state, "Receiver committed data is unavailable.");
      }
    }
    syncLegacyCurrent(state, context);
    handlers.onStatus(`Receiving ${message.file.name}`);
    return;
  }

  if (message.type === "chunk") {
    const context = state.fileStates.get(message.fileId);
    if (!context) {
      failReceiverState(state, "Sender sent a chunk for the wrong file.");
    }
    const chunkOffset = "offset" in message ? message.offset : context.bytes;
    const chunkIndex = "chunkIndex" in message ? message.chunkIndex : context.chunkIndex;
    if (context.state === "completed") {
      options.onChunkCommit?.({
        type: "chunk-commit",
        fileId: message.fileId,
        chunkIndex,
        committedBytes: context.bytes,
      });
      return;
    }
    if (context.state !== "receiving" && context.state !== "reconnecting") {
      failReceiverState(state, "Sender sent a chunk for the wrong file.");
    }
    if (chunkOffset < context.bytes) {
      options.onChunkCommit?.({
        type: "chunk-commit",
        fileId: message.fileId,
        chunkIndex,
        committedBytes: context.bytes,
      });
      return;
    }
    if (chunkOffset !== context.bytes || chunkIndex !== context.chunkIndex) {
      failReceiverState(state, "Sender sent a chunk at the wrong offset.");
    }
    if (!message.chunkDigest || (await digestHex(message.bytes)) !== message.chunkDigest) {
      failReceiverState(state, "Chunk integrity verification failed.");
    }
    await context.sink?.write(chunkOffset, message.bytes, context.file);
    context.digest?.update(message.bytes);
    context.bytes += message.bytes.byteLength;
    context.chunkIndex += 1;
    context.state = "receiving";
    state.committedBytesByFileId.set(message.fileId, context.bytes);
    syncLegacyCurrent(state, context);
    options.onChunkCommit?.({
      type: "chunk-commit",
      fileId: message.fileId,
      chunkIndex,
      committedBytes: context.bytes,
    });
    emitProgress(state, handlers, context.file);
    return;
  }

  if (message.type === "file-end") {
    const context = state.fileStates.get(message.fileId);
    if (context?.state === "completed" && context.bytes === message.bytes) {
      return;
    }
    if (
      context?.state !== "receiving" ||
      context.bytes !== message.bytes ||
      context.bytes !== context.file.size
    ) {
      failReceiverState(state, "File size verification failed.");
    }
    if (context.digest?.digestHex() !== message.digest) {
      failReceiverState(state, "File integrity verification failed.");
    }
    const file = await context.sink?.finalize(context.file);
    if (!file) failReceiverState(state, "Receiver sink finalization failed.");
    context.completedFile = file;
    context.state = "completed";
    context.digest = null;
    context.sink = null;
    state.committedBytesByFileId.set(context.file.id, context.file.size);
    recomputeCompletionTotals(state);
    syncLegacyCurrent(state, null);
    const nextLegacyFile = state.manifest.find((item) => {
      const nextContext = state.fileStates.get(item.id);
      return nextContext && nextContext.state !== "completed";
    });
    if (nextLegacyFile) {
      const nextContext = state.fileStates.get(nextLegacyFile.id) ?? null;
      state.currentBytes = nextContext?.bytes ?? 0;
      state.currentChunkIndex = nextContext?.chunkIndex ?? 0;
    }
    emitProgress(state, handlers, context.file);
    handlers.onFileReceived(file);
    return;
  }

  recomputeCompletionTotals(state);
  if (
    state.receivedFiles !== state.manifest.length ||
    state.completedBytes !== message.totalBytes ||
    state.completedBytes !== state.totalBytes
  ) {
    failReceiverState(state, "Session size verification failed.");
  }
  handlers.onComplete();
}

export function receiverResumeProgress(state: ReceiverProtocolState) {
  return resumeProgressFromState(state);
}
