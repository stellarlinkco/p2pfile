import { expect, test } from "bun:test";
import {
  ClaimSessionResponseSchema,
  CompleteSessionRequestSchema,
  CreateSessionRequestSchema,
  DEFAULT_RETRY_BUDGET,
  ReleaseSessionResponseSchema,
  ResumeProgressSchema,
  resumeProgressFromManifest,
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

test("session state schema accepts all nine lifecycle states", () => {
  const states = [
    "waiting",
    "viewing",
    "claimed",
    "connecting",
    "transferring",
    "completed-view",
    "ended",
    "reconnecting",
    "failed",
  ] as const;

  for (const state of states) {
    expect(SessionStateSchema.parse(state)).toBe(state);
  }
});

test("session state schema accepts recoverable reconnecting state", () => {
  expect(SessionStateSchema.parse("reconnecting")).toBe("reconnecting");
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

test("complete session request requires full-manifest integrity proof", () => {
  const parsed = CompleteSessionRequestSchema.parse({
    receiverToken: "receiver-token-receiver-token",
    completedFiles: [{ id: "file-1", bytes: 128 }],
    totalBytes: 128,
  });

  expect(parsed.completedFiles).toEqual([{ id: "file-1", bytes: 128 }]);
  expect(() =>
    CompleteSessionRequestSchema.parse({
      receiverToken: "receiver-token-receiver-token",
      completedFiles: [],
      totalBytes: 0,
    }),
  ).toThrow();
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

test("release session response covers released and invalid-token statuses", () => {
  const released = ReleaseSessionResponseSchema.parse({
    status: "released",
    session: {
      sessionId: "session-123",
      state: "waiting",
      manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
      summary: { fileCount: 1, totalSize: 128 },
      transferMode: "direct",
      canClaim: true,
      claimed: false,
      completed: false,
      ended: false,
      expiresAt: 123456,
      retriesRemaining: DEFAULT_RETRY_BUDGET,
    },
  });
  const invalid = ReleaseSessionResponseSchema.parse({
    status: "invalid-token",
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
      retriesRemaining: 2,
    },
  });

  expect(released.status).toBe("released");
  expect(invalid.status).toBe("invalid-token");
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

test("receiver-ready signal requires and preserves ResumeProgress", () => {
  const manifest = [{ id: "file-1", name: "archive.zip", size: 131072 }];
  const progress = resumeProgressFromManifest(manifest, new Map([["file-1", 65536]]));
  const ready = SignalEnvelopeSchema.parse({
    type: "receiver-ready",
    payload: {
      completedFiles: 0,
      progress,
      receiverInstanceId: "receiver-reload-1",
    },
  });

  expect(ready).toEqual({
    type: "receiver-ready",
    payload: { completedFiles: 0, progress, receiverInstanceId: "receiver-reload-1" },
  });
  expect(() =>
    SignalEnvelopeSchema.parse({
      type: "receiver-ready",
      payload: { completedFiles: 0 },
    }),
  ).toThrow();
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

test("signal envelope validates relay frames and base64 chunk payloads", () => {
  const relayReady = SignalEnvelopeSchema.parse({
    type: "relay-ready",
    payload: {},
  });
  const relayMessage = SignalEnvelopeSchema.parse({
    type: "relay-message",
    payload: {
      sequence: 7,
      message: {
        type: "chunk",
        fileId: "file-1",
        chunkIndex: 0,
        offset: 0,
        bytesBase64: "YWJj",
        chunkDigest: "0".repeat(64),
      },
    },
  });
  const relayAck = SignalEnvelopeSchema.parse({
    type: "relay-ack",
    payload: {
      sequence: 7,
    },
  });

  expect(relayReady.type).toBe("relay-ready");
  if (relayMessage.type !== "relay-message" || relayAck.type !== "relay-ack") {
    throw new Error("expected relay frames");
  }

  expect(relayMessage.payload.message).toEqual({
    type: "chunk",
    fileId: "file-1",
    chunkIndex: 0,
    offset: 0,
    bytesBase64: "YWJj",
    chunkDigest: "0".repeat(64),
  });
  expect(relayAck.payload.sequence).toBe(7);
  expect(() =>
    SignalEnvelopeSchema.parse({
      type: "relay-message",
      payload: {
        sequence: 8,
        message: {
          type: "chunk",
          fileId: "file-1",
          bytes: new ArrayBuffer(1),
        },
      },
    }),
  ).toThrow();
});

test("resume progress validates committed byte invariants", () => {
  const progress = ResumeProgressSchema.parse({
    manifestHash: "file-1:archive.zip:131072",
    files: [
      {
        fileId: "file-1",
        size: 131072,
        chunkSize: 65536,
        committedBytes: 65536,
        completed: false,
      },
    ],
  });

  expect(progress.files[0]?.committedBytes).toBe(65536);
  expect(() =>
    ResumeProgressSchema.parse({
      manifestHash: "file-1:archive.zip:131072",
      files: [
        {
          fileId: "file-1",
          size: 131072,
          chunkSize: 65536,
          committedBytes: 32768,
          completed: false,
        },
      ],
    }),
  ).toThrow();
});
