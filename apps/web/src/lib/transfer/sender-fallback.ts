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
  private turnAttempted = false;
  private wsRelayFailed = false;

  constructor(
    relayOnly: boolean,
    private readonly handlers: SenderRuntimeHandlers,
  ) {
    this.mode = relayOnly ? "ws-relay" : "direct";
  }

  markDirectFailed(): void {
    this.directFailed = true;
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
    }
  }
}
