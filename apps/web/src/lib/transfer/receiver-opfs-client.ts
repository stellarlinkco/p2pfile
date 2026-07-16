import type { FileManifestItem } from "@p2pfile/shared";
import {
  type OpfsWorkerCommand,
  type OpfsWorkerFailureCode,
  type OpfsWorkerResponse,
  opfsPartName,
} from "./receiver-opfs-worker-protocol";
import type { ReceivedFile } from "./types";

const CHECKPOINT_INTERVAL_MS = 1_000;
let nextGeneration = 1;

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (response: OpfsWorkerResponse) => void;
};

export type LargeFileSinkBackend = {
  readonly committedBytes: number;
  readonly durableBytes: number;
  finalize: () => Promise<{ file: ReceivedFile; digest: string }>;
  reset: () => void;
  restore: (durableBytes: number) => Promise<number>;
  write: (chunkIndex: number, offset: number, bytes: ArrayBuffer) => Promise<void>;
};

class OpfsWorkerStorageError extends Error {
  constructor(
    readonly code: OpfsWorkerFailureCode,
    message: string,
  ) {
    super(message);
  }
}

export function isInvalidOpfsCheckpointError(error: unknown) {
  return error instanceof OpfsWorkerStorageError && error.code === "invalid";
}

function storageError(response: Extract<OpfsWorkerResponse, { type: "error" }>) {
  const prefix =
    response.code === "unsupported"
      ? "Large-file storage is unavailable in this browser."
      : response.code === "quota"
        ? "Large-file storage quota was exceeded."
        : response.code === "locked"
          ? "Large-file storage is locked by another transfer."
          : "Large-file storage failed.";
  return new OpfsWorkerStorageError(response.code, `${prefix} ${response.message}`);
}

export class OpfsWorkerClient implements LargeFileSinkBackend {
  private readonly file: FileManifestItem;
  private readonly generation = nextGeneration++;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;
  private readonly sessionId: string;
  private readonly worker: Worker;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: Error | null = null;
  private nextRequestId = 1;
  private stopped = false;
  /** Main-thread chain so timer flush cannot race an in-flight write/finalize. */
  private operationChain: Promise<void> = Promise.resolve();
  committedBytes = 0;
  durableBytes = 0;

  constructor(
    sessionId: string,
    file: FileManifestItem,
    worker?: Worker,
    private readonly onDurableProgress?: (durableBytes: number) => void,
    private readonly onFailure?: (error: Error) => void,
  ) {
    this.sessionId = sessionId;
    this.file = file;
    this.worker =
      worker ??
      new Worker(new URL("./receiver-opfs.worker.ts", import.meta.url), {
        type: "module",
        name: `p2pfile-opfs-${file.id}`,
      });
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onWorkerError);
    this.ready = this.request({
      type: "open",
      requestId: this.takeRequestId(),
      generation: this.generation,
      sessionId: this.sessionId,
      file: this.file,
    })
      .then(() => undefined)
      .catch((error: Error) => {
        this.stopWithFailure(error);
        throw error;
      });
  }

  async restore(durableBytes: number) {
    return this.runExclusive(async () => {
      await this.ready;
      const response = await this.request({
        type: "restore",
        requestId: this.takeRequestId(),
        generation: this.generation,
        fileId: this.file.id,
        durableBytes,
      });
      this.applyProgress(response);
      return this.durableBytes;
    });
  }

  async write(chunkIndex: number, offset: number, bytes: ArrayBuffer) {
    return this.runExclusive(async () => {
      await this.ready;
      const response = await this.request(
        {
          type: "write",
          requestId: this.takeRequestId(),
          generation: this.generation,
          fileId: this.file.id,
          chunkIndex,
          offset,
          bytes,
        },
        [bytes],
      );
      this.applyProgress(response);
      if (this.durableBytes >= this.committedBytes) {
        this.clearCheckpointTimer();
      } else {
        this.armCheckpointTimer();
      }
    });
  }

  async finalize() {
    return this.runExclusive(async () => {
      await this.ready;
      this.clearCheckpointTimer();
      // Drain any unflushed processed bytes before finalize so EOF durability
      // does not race a pending timer flush posted earlier.
      if (this.durableBytes < this.committedBytes) {
        await this.flushUnlocked("eof");
      }
      const response = await this.request({
        type: "finalize",
        requestId: this.takeRequestId(),
        generation: this.generation,
        fileId: this.file.id,
      });
      if (response.type !== "finalized") {
        throw new Error("Large-file storage returned an invalid finalization response.");
      }
      const previousDurableBytes = this.durableBytes;
      this.committedBytes = response.bytes;
      this.durableBytes = response.durableBytes;
      if (this.durableBytes > previousDurableBytes) {
        this.onDurableProgress?.(this.durableBytes);
      }
      this.detach();
      return {
        file: {
          id: this.file.id,
          name: this.file.name,
          size: this.file.size,
          blob: response.blob,
          url: URL.createObjectURL(response.blob),
        },
        digest: response.digest,
      };
    });
  }

  reset() {
    if (this.stopped) return;
    this.failAll(new Error("Transfer restarted."));
    this.detach();
  }

  private armCheckpointTimer() {
    if (this.checkpointTimer || this.stopped) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      void this.runExclusive(async () => {
        await this.flushUnlocked("timer");
      }).catch((error: Error) => this.stopWithFailure(error));
    }, CHECKPOINT_INTERVAL_MS);
  }

  private async flushUnlocked(reason: "timer" | "eof") {
    if (this.stopped || this.failure || this.durableBytes >= this.committedBytes) return;
    const response = await this.request({
      type: "flush",
      requestId: this.takeRequestId(),
      generation: this.generation,
      fileId: this.file.id,
      reason,
    });
    this.applyProgress(response);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.catch(() => undefined).then(operation);
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private applyProgress(response: OpfsWorkerResponse) {
    if (
      response.type !== "opened" &&
      response.type !== "restored" &&
      response.type !== "written" &&
      response.type !== "flushed"
    ) {
      throw new Error("Large-file storage returned an invalid progress response.");
    }
    const previousDurableBytes = this.durableBytes;
    this.committedBytes = response.processedBytes;
    this.durableBytes = response.durableBytes;
    if (this.durableBytes > previousDurableBytes) {
      this.onDurableProgress?.(this.durableBytes);
    }
  }

  private request(command: OpfsWorkerCommand, transfer: Transferable[] = []) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.stopped) {
      return Promise.reject(new Error("Transfer restarted."));
    }
    const { promise, reject, resolve } = Promise.withResolvers<OpfsWorkerResponse>();
    this.pending.set(command.requestId, { reject, resolve });
    this.worker.postMessage(command, transfer);
    return promise;
  }

  private readonly onMessage = (event: MessageEvent<OpfsWorkerResponse>) => {
    const response = event.data;
    if (response.generation !== this.generation) return;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.type === "error") {
      pending.reject(storageError(response));
      return;
    }
    pending.resolve(response);
  };

  private readonly onWorkerError = () => {
    this.stopWithFailure(new Error("Large-file storage worker stopped unexpectedly."));
  };

  private failAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private stopWithFailure(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.failAll(error);
    this.detach();
    this.onFailure?.(error);
  }

  private clearCheckpointTimer() {
    if (!this.checkpointTimer) return;
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  private takeRequestId() {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return requestId;
  }

  private detach() {
    this.stopped = true;
    this.clearCheckpointTimer();
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.terminate();
  }
}

export { opfsPartName };
