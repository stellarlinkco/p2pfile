import { type FileManifestItem, MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import type { Sha256Digest } from "./digest";
import type { ReceivedFile } from "./types";

const SMALL_FILE_BLOB_LIMIT = 1024 * 1024;
const SINK_READ_CHUNK_BYTES = MANIFEST_CHUNK_BYTES;
// Close/reopen every N chunks so mid-file reload can re-read durable bytes
// without paying open+close cost on every 64 KiB write (~20-30 KB/s in Chromium).
// 2 chunks = 128 KiB balances resume granularity and write amplification.
const OPFS_CHECKPOINT_CHUNKS = 2;

export type ReceiverSink = {
  readonly committedBytes: number;
  /** Bytes guaranteed durable across reload (OPFS closed checkpoints). */
  readonly durableBytes: number;
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
  get durableBytes() {
    return this.committedBytes;
  }

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
  private writable: FileSystemWritableFileStream | null = null;
  private writableFileId: string | null = null;
  private chunksSinceCheckpoint = 0;
  committedBytes = 0;
  durableBytes = 0;

  constructor(private readonly sessionId: string) {}

  private file(file: FileManifestItem) {
    this.filePromise ??= navigator.storage.getDirectory().then((root) =>
      root.getFileHandle(`p2pfile-${this.sessionId}-${file.id}-${file.size}.part`, {
        create: true,
      }),
    );
    return this.filePromise;
  }

  private async closeWritable() {
    if (!this.writable) return;
    const writable = this.writable;
    const durableAtClose = this.committedBytes;
    this.writable = null;
    this.writableFileId = null;
    this.chunksSinceCheckpoint = 0;
    await writable.close();
    this.durableBytes = durableAtClose;
  }

  private async ensureWritable(file: FileManifestItem) {
    if (this.writable && this.writableFileId === file.id) {
      return this.writable;
    }
    await this.closeWritable();
    const handle = await this.file(file);
    // keepExistingData preserves earlier checkpoints when reopening after close.
    this.writable = await handle.createWritable({ keepExistingData: true });
    this.writableFileId = file.id;
    this.chunksSinceCheckpoint = 0;
    return this.writable;
  }

  async write(offset: number, bytes: ArrayBuffer, file: FileManifestItem) {
    const writable = await this.ensureWritable(file);
    await writable.write({ type: "write", position: offset, data: bytes });
    this.committedBytes = offset + bytes.byteLength;
    this.chunksSinceCheckpoint += 1;
    // Checkpoint on a multi-chunk cadence (and at EOF) so reload resume still works.
    if (this.chunksSinceCheckpoint >= OPFS_CHECKPOINT_CHUNKS || this.committedBytes >= file.size) {
      await this.closeWritable();
    }
  }

  async updateDigest(offset: number, length: number, file: FileManifestItem, digest: Sha256Digest) {
    // Must close first: unclosed OPFS writes are not visible via getFile().
    await this.closeWritable();
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
    // Resume starts from already-durable OPFS bytes.
    this.committedBytes = Math.max(this.committedBytes, offset + readBytes);
    this.durableBytes = Math.max(this.durableBytes, offset + readBytes);
    return readBytes;
  }

  async finalize(file: FileManifestItem) {
    await this.closeWritable();
    const blob = await (await this.file(file)).getFile();
    return { id: file.id, name: file.name, size: file.size, blob, url: URL.createObjectURL(blob) };
  }

  reset() {
    void this.closeWritable();
    this.committedBytes = 0;
    this.durableBytes = 0;
    this.filePromise = null;
  }
}

function canUseOpfs() {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

export function createReceiverSink(file: FileManifestItem, sessionId: string): ReceiverSink {
  if (file.size <= SMALL_FILE_BLOB_LIMIT) return new MemoryBlobSink();
  if (canUseOpfs()) return new OpfsSink(sessionId);
  throw new Error("Large-file receiver storage unavailable.");
}
