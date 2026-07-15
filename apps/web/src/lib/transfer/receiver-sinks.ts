import type { FileManifestItem } from "@p2pfile/shared";
import { createSha256Digest, type Sha256Digest } from "./digest";
import { type LargeFileSinkBackend, OpfsWorkerClient } from "./receiver-opfs-client";
import type { ReceivedFile } from "./types";

const SMALL_FILE_BLOB_LIMIT = 1024 * 1024;

export type FinalizedReceiverSink = {
  digest: string;
  file: ReceivedFile;
};

export type ReceiverSink = {
  readonly committedBytes: number;
  /** Bytes guaranteed durable across reload (OPFS flushed checkpoints). */
  readonly durableBytes: number;
  write: (chunkIndex: number, offset: number, bytes: ArrayBuffer) => Promise<void>;
  restore: (durableBytes: number) => Promise<number>;
  finalize: () => Promise<FinalizedReceiverSink>;
  reset: () => void;
};

class MemoryBlobSink implements ReceiverSink {
  private readonly chunks = new Map<number, ArrayBuffer>();
  private digest: Sha256Digest = createSha256Digest();
  committedBytes = 0;

  constructor(
    private readonly file: FileManifestItem,
    private readonly onDurableProgress?: (durableBytes: number) => void,
  ) {}

  get durableBytes() {
    return this.committedBytes;
  }

  async write(_chunkIndex: number, offset: number, bytes: ArrayBuffer) {
    this.chunks.set(offset, bytes);
    this.digest.update(bytes);
    this.committedBytes = offset + bytes.byteLength;
    this.onDurableProgress?.(this.committedBytes);
  }

  async restore(durableBytes: number) {
    this.digest = createSha256Digest();
    let readBytes = 0;
    for (const [offset, bytes] of [...this.chunks.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      if (offset !== readBytes || readBytes >= durableBytes) break;
      const length = Math.min(bytes.byteLength, durableBytes - readBytes);
      this.digest.update(new Uint8Array(bytes, 0, length));
      readBytes += length;
    }
    this.committedBytes = readBytes;
    if (this.committedBytes > 0) this.onDurableProgress?.(this.committedBytes);
    return readBytes;
  }

  async finalize() {
    const chunks = [...this.chunks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, bytes]) => bytes);
    const blob = new Blob(chunks, { type: this.file.mimeType });
    return {
      digest: this.digest.digestHex(),
      file: {
        id: this.file.id,
        name: this.file.name,
        size: this.file.size,
        blob,
        url: URL.createObjectURL(blob),
      },
    };
  }

  reset() {
    this.chunks.clear();
    this.digest = createSha256Digest();
    this.committedBytes = 0;
  }
}

class OpfsSink implements ReceiverSink {
  private readonly backend: LargeFileSinkBackend;
  private lastReportedDurableBytes = 0;

  constructor(
    sessionId: string,
    file: FileManifestItem,
    private readonly onDurableProgress?: (durableBytes: number) => void,
    private readonly onFailure?: (error: Error) => void,
  ) {
    this.backend = largeFileSinkFactory
      ? largeFileSinkFactory(sessionId, file)
      : new OpfsWorkerClient(
          sessionId,
          file,
          undefined,
          this.reportDurableProgress,
          this.onFailure,
        );
  }

  get committedBytes() {
    return this.backend.committedBytes;
  }

  get durableBytes() {
    return this.backend.durableBytes;
  }

  async write(chunkIndex: number, offset: number, bytes: ArrayBuffer) {
    await this.backend.write(chunkIndex, offset, bytes);
    this.reportDurableProgress(this.backend.durableBytes);
  }

  async restore(durableBytes: number) {
    const restoredBytes = await this.backend.restore(durableBytes);
    this.reportDurableProgress(this.backend.durableBytes);
    return restoredBytes;
  }

  async finalize() {
    const finalized = await this.backend.finalize();
    this.reportDurableProgress(this.backend.durableBytes);
    return finalized;
  }

  reset() {
    this.backend.reset();
  }

  private readonly reportDurableProgress = (durableBytes: number) => {
    if (durableBytes <= this.lastReportedDurableBytes) return;
    this.lastReportedDurableBytes = durableBytes;
    this.onDurableProgress?.(durableBytes);
  };
}

type LargeFileSinkFactory = (sessionId: string, file: FileManifestItem) => LargeFileSinkBackend;

let largeFileSinkFactory: LargeFileSinkFactory | null = null;

export function setLargeFileSinkFactoryForTests(factory: LargeFileSinkFactory | null) {
  largeFileSinkFactory = factory;
}

function canUseOpfs() {
  return (
    largeFileSinkFactory !== null ||
    (typeof navigator !== "undefined" &&
      typeof navigator.storage?.getDirectory === "function" &&
      typeof Worker === "function")
  );
}

export function createReceiverSink(
  file: FileManifestItem,
  sessionId: string,
  onDurableProgress?: (durableBytes: number) => void,
  onFailure?: (error: Error) => void,
): ReceiverSink {
  if (file.size <= SMALL_FILE_BLOB_LIMIT) {
    return new MemoryBlobSink(file, onDurableProgress);
  }
  if (canUseOpfs()) return new OpfsSink(sessionId, file, onDurableProgress, onFailure);
  throw new Error("Large-file receiver storage unavailable.");
}
