import { expect, test } from "bun:test";
import {
  ClaimSessionResponseSchema,
  CreateSessionRequestSchema,
  DEFAULT_RETRY_BUDGET,
  SessionStateSchema,
  SignalEnvelopeSchema,
} from "./session";

test("claimed claim response carries retriesRemaining from the default retry budget", () => {
  const parsed = ClaimSessionResponseSchema.parse({
    status: "claimed",
    receiverToken: "receiver-token-receiver-token",
    retriesRemaining: DEFAULT_RETRY_BUDGET,
    session: {
      sessionId: "session-123",
      state: "claimed",
      manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
      summary: { fileCount: 1, totalSize: 128 },
      transferMode: "direct",
      canClaim: false,
      claimed: true,
      completed: false,
      ended: false,
      expiresAt: null,
      retriesRemaining: DEFAULT_RETRY_BUDGET,
    },
  });

  expect(DEFAULT_RETRY_BUDGET).toBe(3);
  if (parsed.status !== "claimed") {
    throw new Error("expected claimed status");
  }
  expect(parsed.retriesRemaining).toBe(3);
});

test("session state schema accepts the failed state", () => {
  expect(SessionStateSchema.parse("failed")).toBe("failed");
});

test("session state schema accepts all eight lifecycle states", () => {
  const states = [
    "waiting",
    "viewing",
    "claimed",
    "connecting",
    "transferring",
    "completed-view",
    "ended",
    "failed",
  ] as const;

  for (const state of states) {
    expect(SessionStateSchema.parse(state)).toBe(state);
  }
});

test("create session request parses a frozen manifest", () => {
  const parsed = CreateSessionRequestSchema.parse({
    manifest: [
      {
        id: "file-1",
        name: "hello.txt",
        size: 128,
        mimeType: "text/plain",
      },
    ],
  });

  expect(parsed.manifest).toHaveLength(1);
  expect(parsed.manifest[0]?.name).toBe("hello.txt");
});

test("claim session response allows occupied status without receiver token", () => {
  const parsed = ClaimSessionResponseSchema.parse({
    status: "occupied",
    session: {
      sessionId: "session-123",
      state: "connecting",
      manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
      summary: { fileCount: 1, totalSize: 128 },
      transferMode: "direct",
      canClaim: false,
      claimed: true,
      completed: false,
      ended: false,
      expiresAt: null,
      retriesRemaining: 2,
      failureReason: "retry-budget-exhausted",
    },
  });

  expect(parsed.status).toBe("occupied");
  expect(parsed.session.claimed).toBe(true);
});

test("signal envelope validates webrtc and mode payloads", () => {
  const offer = SignalEnvelopeSchema.parse({
    type: "offer",
    payload: {
      type: "offer",
      sdp: "v=0",
    },
  });

  const mode = SignalEnvelopeSchema.parse({
    type: "mode",
    payload: {
      mode: "relay",
    },
  });

  expect(offer.type).toBe("offer");
  expect(mode).toEqual({
    type: "mode",
    payload: {
      mode: "relay",
    },
  });
});

test("signal envelope accepts empty ICE candidate end markers", () => {
  const candidate = SignalEnvelopeSchema.parse({
    type: "ice-candidate",
    payload: {
      candidate: "",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
    },
  });

  expect(candidate).toMatchObject({
    type: "ice-candidate",
    payload: { candidate: "" },
  });
});
