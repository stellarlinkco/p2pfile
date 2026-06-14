import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import {
  assertRelayEnvelopeFitsCloudflareLimit,
  CLOUDFLARE_WEBSOCKET_MESSAGE_LIMIT_BYTES,
  fromRelayMessage,
  relayEnvelopeSizeBytes,
  toRelayMessage,
} from "./relay-runtime";

test("relay serialization round-trip keeps the file-end digest", () => {
  const fileEnd = {
    type: "file-end" as const,
    fileId: "file-1",
    bytes: 5,
    digest: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
  };

  expect(fromRelayMessage(toRelayMessage(fileEnd))).toEqual(fileEnd);
});

test("relay chunk envelopes stay below the Cloudflare 32 MiB WebSocket message limit", () => {
  const chunk = toRelayMessage({
    type: "chunk",
    fileId: "file-1",
    chunkIndex: 0,
    offset: 0,
    bytes: new Uint8Array(MANIFEST_CHUNK_BYTES).buffer,
    chunkDigest: "0".repeat(64),
  });

  const envelope = { type: "relay-message" as const, payload: { sequence: 0, message: chunk } };
  expect(relayEnvelopeSizeBytes(envelope)).toBeLessThan(CLOUDFLARE_WEBSOCKET_MESSAGE_LIMIT_BYTES);
  expect(() => assertRelayEnvelopeFitsCloudflareLimit(envelope)).not.toThrow();
});

test("relay envelope size guard rejects messages over the configured limit", () => {
  const message = {
    type: "relay-message" as const,
    payload: {
      sequence: 0,
      message: {
        type: "chunk" as const,
        fileId: "file-1",
        chunkIndex: 0,
        offset: 0,
        bytesBase64: "AAAA",
        chunkDigest: "0".repeat(64),
      },
    },
  };

  expect(() => assertRelayEnvelopeFitsCloudflareLimit(message, 80)).toThrow(
    "Relay message exceeds Cloudflare WebSocket receive limit.",
  );
});
