import { toRelayMessage } from "./relay-runtime";
import type { BrowserSignalMessage, TransferProtocolMessage } from "./types";

type PendingRelayMessage = {
  envelope: BrowserSignalMessage & { type: "relay-message" };
  resolve: () => void;
  sentAt: number;
};

const RESEND_MS = 250;

export class RelayMessageQueue {
  private readonly pending = new Map<number, PendingRelayMessage>();
  private readonly sendEnvelope: (message: BrowserSignalMessage) => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private nextSequence = 0;
  private stopped = false;

  constructor(sendEnvelope: (message: BrowserSignalMessage) => void) {
    this.sendEnvelope = sendEnvelope;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const entry of this.pending.values()) {
        if (now - entry.sentAt < RESEND_MS) {
          continue;
        }

        entry.sentAt = now;
        this.sendEnvelope(entry.envelope);
      }
    }, RESEND_MS);
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

    const { promise, resolve } = Promise.withResolvers<void>();
    this.pending.set(sequence, {
      envelope,
      resolve,
      sentAt: Date.now(),
    });
    this.sendEnvelope(envelope);
    return promise;
  }

  acknowledge(sequence: number) {
    const pending = this.pending.get(sequence);
    if (!pending) {
      return;
    }

    this.pending.delete(sequence);
    pending.resolve();
  }

  reset() {
    for (const pending of this.pending.values()) {
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
