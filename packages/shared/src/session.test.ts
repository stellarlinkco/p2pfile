import { expect, test } from "bun:test";
import {
  ClaimSessionResponseSchema,
  CreateSessionRequestSchema,
  SignalEnvelopeSchema,
} from "./session";

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
      state: "claimed",
      manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
      summary: { fileCount: 1, totalSize: 128 },
      transferMode: "direct",
      canClaim: false,
      claimed: true,
      completed: false,
      ended: false,
      expiresAt: null,
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
