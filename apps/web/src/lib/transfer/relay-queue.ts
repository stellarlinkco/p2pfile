import {
  assertRelayEnvelopeFitsCloudflareLimit,
  encodeBinaryRelayChunkFrame,
  toRelayMessage,
} from "./relay-runtime";
import type { BrowserSignalMessage, TransferProtocolMessage } from "./types";

type PendingRelayMessage = {
  attempts: number;
  messageType: TransferProtocolMessage["type"];
  wire: string | ArrayBuffer;
  reject: (error: Error) => void;
  resolve: () => void;
  nextResendAt: number;
  resendDelayMs: number;
  timer: ReturnType<typeof setTimeout>;
};

type PendingChunkCommit = {
  expectedCommittedBytes: number;
  reject: (error: Error) => void;
  resolve: (committedBytes: number) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type SendWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export type RelayMessageQueueOptions = {
  ackTimeoutMs?: number;
  commitTimeoutMs?: number;
  /** Initial resend delay. Doubles after each resend until maxResendMs. */
  resendMs?: number;
  maxResendMs?: number;
  /** Cap outstanding unacked relay frames to avoid flood/retry storms. */
  maxUnacked?: number;
  /** Chunk payloads use compact binary frames when true (default). */
  useBinaryChunks?: boolean;
};

const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_COMMIT_TIMEOUT_MS = 15_000;
const DEFAULT_RESEND_MS = 250;
const DEFAULT_MAX_RESEND_MS = 4_000;
const DEFAULT_MAX_UNACKED = 8;
/** Relay chunk payloads use compact binary frames by default. */
const DEFAULT_USE_BINARY_CHUNKS = true;

export class RelayMessageQueue {
  private readonly ackTimeoutMs: number;
  private readonly commitTimeoutMs: number;
  private readonly pending = new Map<number, PendingRelayMessage>();
  private readonly pendingCommits = new Map<string, PendingChunkCommit>();
  private readonly sendWaiters: SendWaiter[] = [];
  private readonly sendWire: (data: string | ArrayBuffer) => void;
  private readonly resendMs: number;
  private readonly maxResendMs: number;
  private readonly maxUnacked: number;
  private readonly useBinaryChunks: boolean;
  private readonly timer: ReturnType<typeof setInterval>;
  private reservedSlots = 0;
  private generation = 0;
  private nextSequence = 0;
  private stopped = false;
  private failure: Error | null = null;

  constructor(sendWire: (data: string | ArrayBuffer) => void, options?: RelayMessageQueueOptions) {
    this.sendWire = sendWire;
    this.ackTimeoutMs = options?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.commitTimeoutMs = options?.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS;
    this.resendMs = options?.resendMs ?? DEFAULT_RESEND_MS;
    this.maxResendMs = options?.maxResendMs ?? DEFAULT_MAX_RESEND_MS;
    this.maxUnacked = Math.max(1, options?.maxUnacked ?? DEFAULT_MAX_UNACKED);
    this.useBinaryChunks = options?.useBinaryChunks ?? DEFAULT_USE_BINARY_CHUNKS;
    this.timer = setInterval(
      () => {
        const now = Date.now();
        for (const entry of this.pending.values()) {
          if (now < entry.nextResendAt) {
            continue;
          }

          entry.nextResendAt = now + entry.resendDelayMs;
          entry.resendDelayMs = Math.min(this.maxResendMs, entry.resendDelayMs * 2);
          entry.attempts += 1;
          this.sendWire(entry.wire);
        }
      },
      Math.min(50, this.resendMs),
    );
  }

  private commitKey(fileId: string, chunkIndex: number) {
    return `${fileId}:${chunkIndex}`;
  }

  private acknowledgementTimeoutError(pending: PendingRelayMessage, sequence: number) {
    const attempts = `${pending.attempts} attempt${pending.attempts === 1 ? "" : "s"}`;
    return new Error(
      `Relay acknowledgement timed out (sequence ${sequence}, ${pending.messageType}, ${attempts}).`,
    );
  }
  private rejectPending(error: Error) {
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingCommits.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommits.clear();
    while (this.sendWaiters.length > 0) {
      this.sendWaiters.shift()?.reject(error);
    }
  }

  private hasSendCapacity() {
    return this.pending.size + this.reservedSlots < this.maxUnacked;
  }

  private wakeSendWaiters() {
    while (this.sendWaiters.length > 0 && this.hasSendCapacity()) {
      this.reservedSlots += 1;
      this.sendWaiters.shift()?.resolve();
    }
  }

  private waitForSendSlot(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error("Transfer restarted."));
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const generation = this.generation;
    let slot: Promise<void>;
    if (this.hasSendCapacity()) {
      this.reservedSlots += 1;
      slot = Promise.resolve();
    } else {
      const { promise, reject, resolve } = Promise.withResolvers<void>();
      this.sendWaiters.push({ reject, resolve });
      slot = promise;
    }
    return slot.then(() => {
      if (generation !== this.generation) throw new Error("Transfer restarted.");
      this.reservedSlots -= 1;
      if (this.failure) throw this.failure;
      if (this.stopped) throw new Error("Transfer restarted.");
    });
  }

  private encodeWire(sequence: number, message: TransferProtocolMessage): string | ArrayBuffer {
    if (this.useBinaryChunks && message.type === "chunk") {
      return encodeBinaryRelayChunkFrame(sequence, message);
    }

    const envelope: BrowserSignalMessage & { type: "relay-message" } = {
      type: "relay-message",
      payload: {
        sequence,
        message: toRelayMessage(message),
      },
    };
    assertRelayEnvelopeFitsCloudflareLimit(envelope);
    return JSON.stringify(envelope);
  }

  private enqueue(message: TransferProtocolMessage): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const wire = this.encodeWire(sequence, message);
    const { promise, reject, resolve } = Promise.withResolvers<void>();
    const now = Date.now();
    const pending: PendingRelayMessage = {
      attempts: 1,
      messageType: message.type,
      wire,
      reject,
      resolve,
      nextResendAt: now + this.resendMs,
      resendDelayMs: this.resendMs,
      timer: setTimeout(() => {
        const nextPending = this.pending.get(sequence);
        if (!nextPending) {
          return;
        }

        this.pending.delete(sequence);
        clearTimeout(nextPending.timer);
        nextPending.reject(this.acknowledgementTimeoutError(nextPending, sequence));
        this.wakeSendWaiters();
      }, this.ackTimeoutMs),
    };

    this.pending.set(sequence, pending);
    this.sendWire(wire);
    return promise;
  }

  /**
   * When a send slot is free, registration is synchronous so callers can
   * immediately fail/nack the returned in-flight sequence.
   */
  send(message: TransferProtocolMessage): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.hasSendCapacity()) {
      return this.enqueue(message);
    }

    return this.waitForSendSlot().then(() => this.enqueue(message));
  }

  awaitCommit(fileId: string, chunkIndex: number, expectedCommittedBytes: number) {
    if (this.stopped) {
      return Promise.reject(new Error("Transfer restarted."));
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const key = this.commitKey(fileId, chunkIndex);
    const { promise, reject, resolve } = Promise.withResolvers<number>();
    const pending: PendingChunkCommit = {
      expectedCommittedBytes,
      reject,
      resolve,
      timer: null,
    };
    this.pendingCommits.set(key, pending);
    return promise.finally(() => {
      const current = this.pendingCommits.get(key);
      if (current === pending) {
        this.pendingCommits.delete(key);
      }
    });
  }

  armCommitTimeout(fileId: string, chunkIndex: number) {
    const key = this.commitKey(fileId, chunkIndex);
    const pending = this.pendingCommits.get(key);
    if (!pending || pending.timer) {
      return;
    }

    pending.timer = setTimeout(() => {
      const nextPending = this.pendingCommits.get(key);
      if (!nextPending || nextPending !== pending) {
        return;
      }

      this.pendingCommits.delete(key);
      if (nextPending.timer) clearTimeout(nextPending.timer);
      nextPending.reject(new Error("Relay chunk commit timed out."));
    }, this.commitTimeoutMs);
  }

  commit(message: Extract<TransferProtocolMessage, { type: "chunk-commit" }>) {
    const key = this.commitKey(message.fileId, message.chunkIndex);
    const pending = this.pendingCommits.get(key);
    if (!pending) {
      return;
    }
    if (message.committedBytes !== pending.expectedCommittedBytes) {
      return;
    }

    this.pendingCommits.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
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
    this.wakeSendWaiters();
  }

  nack(sequence: number, reason = "peer-unavailable") {
    const pending = this.pending.get(sequence);
    if (!pending) {
      return;
    }

    this.pending.delete(sequence);
    clearTimeout(pending.timer);
    const message =
      reason === "peer-unavailable"
        ? "Relay peer unavailable."
        : `Relay delivery rejected (${reason}).`;
    pending.reject(new Error(message));
    this.wakeSendWaiters();
  }

  fail(error: Error) {
    this.rejectPending(error);
  }

  private beginNewGeneration() {
    this.generation += 1;
    this.reservedSlots = 0;
  }

  reset() {
    this.beginNewGeneration();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transfer restarted."));
    }
    this.pending.clear();
    for (const pending of this.pendingCommits.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("Transfer restarted."));
    }
    this.pendingCommits.clear();
    while (this.sendWaiters.length > 0) {
      this.sendWaiters.shift()?.reject(new Error("Transfer restarted."));
    }
    this.failure = null;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.reset();
  }
}
