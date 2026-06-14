import { assertRelayEnvelopeFitsCloudflareLimit, toRelayMessage } from "./relay-runtime";
import type { BrowserSignalMessage, TransferProtocolMessage } from "./types";

type PendingRelayMessage = {
  envelope: BrowserSignalMessage & { type: "relay-message" };
  reject: (error: Error) => void;
  resolve: () => void;
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type PendingChunkCommit = {
  reject: (error: Error) => void;
  resolve: (committedBytes: number) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_COMMIT_TIMEOUT_MS = 15_000;
const DEFAULT_RESEND_MS = 250;

export class RelayMessageQueue {
  private readonly ackTimeoutMs: number;
  private readonly commitTimeoutMs: number;
  private readonly pending = new Map<number, PendingRelayMessage>();
  private readonly pendingCommits = new Map<string, PendingChunkCommit>();
  private readonly sendEnvelope: (message: BrowserSignalMessage) => void;
  private readonly resendMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private nextSequence = 0;
  private stopped = false;

  constructor(
    sendEnvelope: (message: BrowserSignalMessage) => void,
    options?: { ackTimeoutMs?: number; commitTimeoutMs?: number; resendMs?: number },
  ) {
    this.sendEnvelope = sendEnvelope;
    this.ackTimeoutMs = options?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.commitTimeoutMs = options?.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS;
    this.resendMs = options?.resendMs ?? DEFAULT_RESEND_MS;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const entry of this.pending.values()) {
        if (now - entry.sentAt < this.resendMs) {
          continue;
        }

        entry.sentAt = now;
        this.sendEnvelope(entry.envelope);
      }
    }, this.resendMs);
  }

  send(message: TransferProtocolMessage) {
    if (this.stopped) {
      return Promise.resolve();
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;

    const envelope: BrowserSignalMessage & { type: "relay-message" } = {
      type: "relay-message",
      payload: {
        sequence,
        message: toRelayMessage(message),
      },
    };
    assertRelayEnvelopeFitsCloudflareLimit(envelope);

    const { promise, reject, resolve } = Promise.withResolvers<void>();
    const pending: PendingRelayMessage = {
      envelope,
      reject,
      resolve,
      sentAt: Date.now(),
      timer: setTimeout(() => {
        const nextPending = this.pending.get(sequence);
        if (!nextPending) {
          return;
        }

        this.pending.delete(sequence);
        clearTimeout(nextPending.timer);
        nextPending.reject(new Error("Relay acknowledgement timed out."));
      }, this.ackTimeoutMs),
    };

    this.pending.set(sequence, pending);
    this.sendEnvelope(envelope);
    return promise;
  }

  awaitCommit(fileId: string, chunkIndex: number, _expectedCommittedBytes: number) {
    if (this.stopped) {
      return Promise.reject(new Error("Transfer restarted."));
    }

    const key = `${fileId}:${chunkIndex}`;
    const { promise, reject, resolve } = Promise.withResolvers<number>();
    const pending: PendingChunkCommit = {
      reject,
      resolve,
      timer: setTimeout(() => {
        const nextPending = this.pendingCommits.get(key);
        if (!nextPending) {
          return;
        }

        this.pendingCommits.delete(key);
        clearTimeout(nextPending.timer);
        nextPending.reject(new Error("Relay chunk commit timed out."));
      }, this.commitTimeoutMs),
    };
    this.pendingCommits.set(key, pending);
    return promise.finally(() => {
      this.pendingCommits.delete(key);
    });
  }

  commit(message: Extract<TransferProtocolMessage, { type: "chunk-commit" }>) {
    const key = `${message.fileId}:${message.chunkIndex}`;
    const pending = this.pendingCommits.get(key);
    if (!pending) {
      return;
    }

    this.pendingCommits.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(message.committedBytes);
  }

  acknowledge(sequence: number) {
    const pending = this.pending.get(sequence);
    if (!pending) {
      return;
    }

    this.pending.delete(sequence);
    clearTimeout(pending.timer);
    pending.resolve();
  }

  reset() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pending.clear();
    for (const pending of this.pendingCommits.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transfer restarted."));
    }
    this.pendingCommits.clear();
    this.nextSequence = 0;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.reset();
  }
}
