import { expect, test } from "bun:test";
import { ClaimRequestSchema, SignalEnvelopeSchema } from "./session";

test("claim request parses valid payload", () => {
  const parsed = ClaimRequestSchema.parse({
    sessionId: "session-123",
  });

  expect(parsed.sessionId).toBe("session-123");
});

test("signal envelope validates transfer mode payload", () => {
  const parsed = SignalEnvelopeSchema.parse({
    type: "session:mode",
    payload: {
      sessionId: "session-456",
      mode: "direct",
    },
  });

  expect(parsed).toEqual({
    type: "session:mode",
    payload: {
      sessionId: "session-456",
      mode: "direct",
    },
  });
});
