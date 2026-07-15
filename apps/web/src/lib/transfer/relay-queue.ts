import { RelayRtoEstimator } from "./relay-rto";
import {
  assertRelayEnvelopeFitsCloudflareLimit,
  encodeBinaryRelayChunkFrame,
  toRelayMessage,
} from "./relay-runtime";
import type { BrowserSignalMessage, TransferProtocolMessage } from "./types";

type PendingRelayMessage = {
  attempts: number;
  firstSentAt: number;
  messageType: TransferProtocolMessage["type"];
  wire: string | ArrayBuffer;
  wireBytes: number;
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
  startedAt: number;
};

type SendWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export type RelayMessageQueueOptions = {
  ackTimeoutMs?: number;
  commitTimeoutMs?: number;
  initialRtoMs?: number;
  minRtoMs?: number;
  maxRtoMs?: number;
  /** Cap outstanding unacknowledged Relay frames. */
  maxUnacked?: number;
  /** Chunk payloads use compact binary frames when true (default). */
  useBinaryChunks?: boolean;
};

export type RelayQueueTelemetry = {
  deliveryAckRttMs: number[];
  commitRttMs: number[];
  ineligibleDeliveryAckSamples: number;
  sentFrames: number;
  applicationResends: number;
  originalWireBytes: number;
  transmittedWireBytes: number;
  pendingWireBytes: number;
  peakPendingWireBytes: number;
  acknowledgementTimeouts: number;
  nacks: number;
  currentRtoMs: number;
};

const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_COMMIT_TIMEOUT_MS = 15_000;
const DEFAULT_INITIAL_RTO_MS = 1_000;
const DEFAULT_MIN_RTO_MS = 500;
const DEFAULT_MAX_RTO_MS = 4_000;
const DEFAULT_MAX_UNACKED = 8;
/** Relay chunk payloads use compact binary frames by default. */
const DEFAULT_USE_BINARY_CHUNKS = true;

const MAX_RECORDED_RTT_SAMPLES = 256;
export class RelayMessageQueue {
  private readonly ackTimeoutMs: number;
  private readonly commitTimeoutMs: number;
  private readonly pending = new Map<number, PendingRelayMessage>();
  private readonly pendingCommits = new Map<string, PendingChunkCommit>();
  private readonly sendWaiters: SendWaiter[] = [];
  private readonly sendWire: (data: string | ArrayBuffer) => void;
  private readonly maxRtoMs: number;
  private readonly maxUnacked: number;
  private readonly rtoEstimator: RelayRtoEstimator;
  private readonly useBinaryChunks: boolean;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly deliveryAckRttMs: number[] = [];
  private readonly commitRttMs: number[] = [];
  private ineligibleDeliveryAckSamples = 0;
  private sentFrames = 0;
  private applicationResends = 0;
  private originalWireBytes = 0;
  private transmittedWireBytes = 0;
  private pendingWireBytes = 0;
  private peakPendingWireBytes = 0;
  private acknowledgementTimeouts = 0;
  private nacks = 0;
  private reportedRtoMs: number;
  private rtoUpdatedSinceTelemetry = false;
  private reservedSlots = 0;
  private generation = 0;
  private nextSequence = 0;
  private stopped = false;
  private failure: Error | null = null;

  constructor(sendWire: (data: string | ArrayBuffer) => void, options?: RelayMessageQueueOptions) {
    this.sendWire = sendWire;
    this.ackTimeoutMs = options?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.commitTimeoutMs = options?.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS;
    const minRtoMs = Math.max(1, options?.minRtoMs ?? DEFAULT_MIN_RTO_MS);
    this.maxRtoMs = Math.max(minRtoMs, options?.maxRtoMs ?? DEFAULT_MAX_RTO_MS);
    this.rtoEstimator = new RelayRtoEstimator({
      initialMs: options?.initialRtoMs ?? DEFAULT_INITIAL_RTO_MS,
      minMs: minRtoMs,
      maxMs: this.maxRtoMs,
    });
    this.reportedRtoMs = this.rtoEstimator.currentMs;
    this.maxUnacked = Math.max(1, options?.maxUnacked ?? DEFAULT_MAX_UNACKED);
    this.useBinaryChunks = options?.useBinaryChunks ?? DEFAULT_USE_BINARY_CHUNKS;
    this.timer = setInterval(() => this.resendExpired(), Math.min(50, this.rtoEstimator.currentMs));
  }

  pendingWireByteLength() {
    return this.pendingWireBytes;
  }

  getTelemetry(): RelayQueueTelemetry {
    return {
      deliveryAckRttMs: [...this.deliveryAckRttMs],
      commitRttMs: [...this.commitRttMs],
      ineligibleDeliveryAckSamples: this.ineligibleDeliveryAckSamples,
      sentFrames: this.sentFrames,
      applicationResends: this.applicationResends,
      originalWireBytes: this.originalWireBytes,
      transmittedWireBytes: this.transmittedWireBytes,
      pendingWireBytes: this.pendingWireBytes,
      peakPendingWireBytes: this.peakPendingWireBytes,
      acknowledgementTimeouts: this.acknowledgementTimeouts,
      nacks: this.nacks,
      currentRtoMs: this.reportedRtoMs,
    };
  }

  takeTelemetry() {
    const telemetry = this.getTelemetry();
    this.resetTelemetry();
    this.rtoUpdatedSinceTelemetry = false;
    this.reportedRtoMs = this.rtoEstimator.currentMs;
    return telemetry;
  }

  private resendExpired() {
    const now = Date.now();
    for (const entry of this.pending.values()) {
      if (now < entry.nextResendAt) continue;
      entry.attempts += 1;
      entry.resendDelayMs = Math.min(this.maxRtoMs, entry.resendDelayMs * 2);
      entry.nextResendAt = now + entry.resendDelayMs;
      this.applicationResends += 1;
      this.transmittedWireBytes += entry.wireBytes;
      this.sendWire(entry.wire);
    }
  }

  private wireByteLength(wire: string | ArrayBuffer) {
    return typeof wire === "string" ? new TextEncoder().encode(wire).byteLength : wire.byteLength;
  }

  private recordSample(samples: number[], value: number) {
    if (samples.length === MAX_RECORDED_RTT_SAMPLES) samples.shift();
    samples.push(value);
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
    this.pendingWireBytes = 0;
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
    const wireBytes = this.wireByteLength(wire);
    const { promise, reject, resolve } = Promise.withResolvers<void>();
    const now = Date.now();
    const initialRtoMs = this.rtoEstimator.currentMs;
    const pending: PendingRelayMessage = {
      attempts: 1,
      firstSentAt: now,
      messageType: message.type,
      wire,
      wireBytes,
      reject,
      resolve,
      nextResendAt: now + initialRtoMs,
      resendDelayMs: initialRtoMs,
      timer: setTimeout(() => {
        const nextPending = this.pending.get(sequence);
        if (!nextPending) {
          return;
        }

        this.pending.delete(sequence);
        clearTimeout(nextPending.timer);
        this.pendingWireBytes = Math.max(0, this.pendingWireBytes - nextPending.wireBytes);
        this.acknowledgementTimeouts += 1;
        nextPending.reject(this.acknowledgementTimeoutError(nextPending, sequence));
        this.wakeSendWaiters();
      }, this.ackTimeoutMs),
    };

    this.sentFrames += 1;
    this.originalWireBytes += wireBytes;
    this.transmittedWireBytes += wireBytes;
    this.pendingWireBytes += wireBytes;
    this.peakPendingWireBytes = Math.max(this.peakPendingWireBytes, this.pendingWireBytes);
    if (message.type === "chunk") {
      const commit = this.pendingCommits.get(this.commitKey(message.fileId, message.chunkIndex));
      if (commit) commit.startedAt = now;
    }
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
      startedAt: 0,
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
    if (pending.startedAt > 0) {
      this.recordSample(this.commitRttMs, Math.max(0, Date.now() - pending.startedAt));
    }
    pending.resolve(message.committedBytes);
  }

  acknowledge(sequence: number) {
    const pending = this.pending.get(sequence);
    if (!pending) {
      return;
    }

    this.pending.delete(sequence);
    clearTimeout(pending.timer);
    this.pendingWireBytes = Math.max(0, this.pendingWireBytes - pending.wireBytes);
    if (pending.attempts === 1) {
      const deliveryRttMs = Math.max(0, Date.now() - pending.firstSentAt);
      this.recordSample(this.deliveryAckRttMs, deliveryRttMs);
      this.rtoEstimator.record(deliveryRttMs);
      this.reportedRtoMs = this.rtoEstimator.currentMs;
      this.rtoUpdatedSinceTelemetry = true;
    } else {
      this.ineligibleDeliveryAckSamples += 1;
    }
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
    this.pendingWireBytes = Math.max(0, this.pendingWireBytes - pending.wireBytes);
    this.nacks += 1;
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

  private resetTelemetry() {
    this.deliveryAckRttMs.length = 0;
    this.commitRttMs.length = 0;
    this.ineligibleDeliveryAckSamples = 0;
    this.sentFrames = 0;
    this.applicationResends = 0;
    this.originalWireBytes = 0;
    this.transmittedWireBytes = 0;
    this.peakPendingWireBytes = this.pendingWireBytes;
    this.acknowledgementTimeouts = 0;
    this.nacks = 0;
  }

  reset() {
    const preserveReportedRto = this.rtoUpdatedSinceTelemetry;
    this.beginNewGeneration();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transfer restarted."));
    }
    this.pending.clear();
    this.pendingWireBytes = 0;
    for (const pending of this.pendingCommits.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("Transfer restarted."));
    }
    this.pendingCommits.clear();
    while (this.sendWaiters.length > 0) {
      this.sendWaiters.shift()?.reject(new Error("Transfer restarted."));
    }
    this.failure = null;
    this.rtoEstimator.reset();
    if (!preserveReportedRto) this.reportedRtoMs = this.rtoEstimator.currentMs;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.reset();
  }
}
