import { decideFallbackStep } from "./fallback-policy";
import { turnConfigured } from "./runtime-shared";
import type { SenderRuntimeHandlers } from "./types";

export type SenderFallbackMode = "direct" | "turn" | "ws-relay";

type SenderFallbackActions = {
  startTurnAttempt: () => void;
  startRelayTransfer: () => void;
};

export class SenderFallbackController {
  mode: SenderFallbackMode;
  private directFailed = false;
  private relayModeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly relayOnly: boolean;
  private turnAttempted = false;
  private wsRelayFailed = false;

  constructor(
    relayOnly: boolean,
    private readonly handlers: SenderRuntimeHandlers,
  ) {
    this.relayOnly = relayOnly;
    this.mode = relayOnly ? "ws-relay" : "direct";
  }

  markDirectFailed(): void {
    this.directFailed = true;
  }

  /** Receiver reload is not a transport failure; allow a fresh direct attempt. */
  clearDirectFailure(): void {
    this.directFailed = false;
    this.wsRelayFailed = false;
    // Keep intentional test/relay-only mode; only unwind failure-driven WS relay.
    if (!this.relayOnly && this.mode === "ws-relay") {
      this.mode = "direct";
    }
  }

  markRelayFailed(): void {
    this.wsRelayFailed = true;
  }

  noteDirectAttempt(mode: SenderFallbackMode): void {
    this.mode = mode;
    if (mode === "turn") {
      this.turnAttempted = true;
    }
  }

  startRelayMode(sendRelayMode: () => void): void {
    this.stopRelayMode();
    sendRelayMode();
    this.relayModeTimer = setInterval(sendRelayMode, 250);
  }

  stopRelayMode(): void {
    if (this.relayModeTimer) {
      clearInterval(this.relayModeTimer);
      this.relayModeTimer = null;
    }
  }

  continue(actions: SenderFallbackActions): void {
    const step = decideFallbackStep({
      directFailed: this.directFailed,
      turnConfigured: turnConfigured(),
      turnAttempted: this.turnAttempted,
      wsRelayFailed: this.wsRelayFailed,
    });

    if (step === "turn") {
      actions.startTurnAttempt();
      return;
    }

    if (step === "ws-relay") {
      this.mode = "ws-relay";
      actions.startRelayTransfer();
      return;
    }

    if (step === "fail") {
      this.handlers.onError("Relay transfer failed.");
      return;
    }
  }
}
