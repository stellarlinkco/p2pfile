import { expect, test } from "bun:test";
import { SenderFallbackController } from "./sender-fallback";
import type { SenderRuntimeHandlers } from "./types";

function handlersWith(onError: (message: string) => void): SenderRuntimeHandlers {
  return {
    onStatus() {},
    onMode() {},
    onProgress() {},
    onComplete() {},
    onError,
  };
}

test("sender fallback reports the existing connection guidance after direct and relay failure", () => {
  const errors: string[] = [];
  const controller = new SenderFallbackController(
    false,
    handlersWith((message) => errors.push(message)),
  );

  controller.markDirectFailed();
  controller.markRelayFailed();
  controller.continue({ startTurnAttempt() {}, startRelayTransfer() {} });

  expect(errors).toEqual(["Relay transfer failed."]);
});
