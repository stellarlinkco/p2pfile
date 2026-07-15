import { type FileManifestItem, MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { createSha256Digest, type Sha256Digest } from "./digest";

const DEFAULT_CHECKPOINT_BYTES = 1024 * 1024;

export type OpfsSyncAccessHandle = {
  close: () => void;
  flush: () => void;
  getSize: () => number;
  truncate: (newSize: number) => void;
  read: (buffer: ArrayBufferView, options?: { at?: number }) => number;
  write: (buffer: ArrayBufferView, options?: { at?: number }) => number;
};

type OpfsFileCoreOptions = {
  checkpointBytes?: number;
};

export class OpfsFileCore {
  private readonly checkpointBytes: number;
  private readonly file: FileManifestItem;
  private readonly handle: OpfsSyncAccessHandle;
  private digest: Sha256Digest = createSha256Digest();
  private closed = false;
  processedBytes = 0;
  durableBytes = 0;

  constructor(
    handle: OpfsSyncAccessHandle,
    file: FileManifestItem,
    options: OpfsFileCoreOptions = {},
  ) {
    this.handle = handle;
    this.file = file;
    this.checkpointBytes = Math.max(
      MANIFEST_CHUNK_BYTES,
      Math.floor(options.checkpointBytes ?? DEFAULT_CHECKPOINT_BYTES),
    );
  }

  restore(durableBytes: number) {
    this.assertOpen();
    if (this.processedBytes !== 0 || this.durableBytes !== 0) {
      throw new Error("OPFS progress is already initialized.");
    }
    const storedSize = this.handle.getSize();
    if (
      durableBytes < 0 ||
      durableBytes > this.file.size ||
      durableBytes > storedSize ||
      (durableBytes !== this.file.size && durableBytes % MANIFEST_CHUNK_BYTES !== 0)
    ) {
      throw new Error("OPFS durable offset is invalid.");
    }
    if (storedSize > durableBytes) this.handle.truncate(durableBytes);

    const scratch = new Uint8Array(MANIFEST_CHUNK_BYTES);
    let offset = 0;
    while (offset < durableBytes) {
      const length = Math.min(MANIFEST_CHUNK_BYTES, durableBytes - offset);
      const bytes = length === scratch.byteLength ? scratch : scratch.subarray(0, length);
      const read = this.handle.read(bytes, { at: offset });
      if (read !== length) {
        throw new Error("OPFS durable prefix could not be restored.");
      }
      this.digest.update(bytes);
      offset += read;
    }
    this.processedBytes = durableBytes;
    this.durableBytes = durableBytes;
  }

  write(chunkIndex: number, offset: number, bytes: ArrayBuffer) {
    this.assertOpen();
    const expectedChunkIndex = Math.floor(offset / MANIFEST_CHUNK_BYTES);
    const remaining = this.file.size - offset;
    if (
      offset !== this.processedBytes ||
      chunkIndex !== expectedChunkIndex ||
      bytes.byteLength === 0 ||
      bytes.byteLength > MANIFEST_CHUNK_BYTES ||
      bytes.byteLength > remaining
    ) {
      throw new Error("OPFS chunk position is invalid.");
    }

    const view = new Uint8Array(bytes);
    const written = this.handle.write(view, { at: offset });
    if (written !== view.byteLength) {
      throw new Error("OPFS wrote an incomplete chunk.");
    }

    this.digest.update(view);
    this.processedBytes += written;
    const unflushedBytes = this.processedBytes - this.durableBytes;
    const shouldFlush =
      this.processedBytes === this.file.size || unflushedBytes >= this.checkpointBytes;
    if (shouldFlush) {
      this.flush();
    }

    return { processedBytes: this.processedBytes, durableBytes: this.durableBytes };
  }

  flush() {
    this.assertOpen();
    if (this.processedBytes === this.durableBytes) {
      return this.durableBytes;
    }
    this.handle.flush();
    this.durableBytes = this.processedBytes;
    return this.durableBytes;
  }

  finalize() {
    this.assertOpen();
    if (this.processedBytes !== this.file.size) {
      throw new Error("OPFS file is incomplete.");
    }
    this.flush();
    const result = {
      bytes: this.processedBytes,
      durableBytes: this.durableBytes,
      digest: this.digest.digestHex(),
    };
    this.close();
    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.handle.close();
  }

  private assertOpen() {
    if (this.closed) {
      throw new Error("OPFS file handle is closed.");
    }
  }
}
