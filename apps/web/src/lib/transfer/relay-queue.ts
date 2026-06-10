import { toRelayMessage } from "./relay-runtime";
import type { BrowserSignalMessage, TransferProtocolMessage } from "./types";

type PendingRelayMessage = {
  envelope: BrowserSignalMessage & { type: "relay-message" };
  reject: (error: Error) => void;
  resolve: () => void;
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_RESEND_MS = 250;

export class RelayMessageQueue {
  private readonly ackTimeoutMs: number;
  private readonly pending = new Map<number, PendingRelayMessage>();
  private readonly sendEnvelope: (message: BrowserSignalMessage) => void;
  private readonly resendMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private nextSequence = 0;
  private stopped = false;

  constructor(
    sendEnvelope: (message: BrowserSignalMessage) => void,
    options?: { ackTimeoutMs?: number; resendMs?: number },
  ) {
    this.sendEnvelope = sendEnvelope;
    this.ackTimeoutMs = options?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
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
    this.nextSequence = 0;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.reset();
  }
}
