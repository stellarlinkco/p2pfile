export type FallbackSignals = {
  directFailed: boolean;
  turnConfigured: boolean;
  turnAttempted: boolean;
  wsRelayFailed: boolean;
};

export type FallbackStep = "direct-retry" | "turn" | "ws-relay" | "fail";

export function decideFallbackStep(signals: FallbackSignals): FallbackStep {
  if (!signals.directFailed) {
    return "direct-retry";
  }

  if (signals.turnConfigured && !signals.turnAttempted) {
    return "turn";
  }

  return signals.wsRelayFailed ? "fail" : "ws-relay";
}
