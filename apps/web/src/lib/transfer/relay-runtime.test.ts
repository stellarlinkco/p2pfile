import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import {
  assertRelayEnvelopeFitsCloudflareLimit,
  CLOUDFLARE_WEBSOCKET_MESSAGE_LIMIT_BYTES,
  decodeBinaryChunk,
  decodeBinaryRelayChunkFrame,
  decodeChunk,
  encodeBinaryChunk,
  encodeBinaryRelayChunkFrame,
  encodeChunk,
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

test("encodeChunk/decodeChunk round-trip preserves arbitrary bytes", () => {
  const bytes = new Uint8Array(MANIFEST_CHUNK_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 17 + 3) % 256;
  }

  const decoded = new Uint8Array(decodeChunk(encodeChunk(bytes.buffer)));
  expect(decoded).toEqual(bytes);
});

test("encodeChunk stays under a tight budget for one 64 KiB chunk", () => {
  const bytes = new Uint8Array(MANIFEST_CHUNK_BYTES);
  bytes.fill(7);
  // Warm once so the assertion measures steady-state cost.
  encodeChunk(bytes.buffer);

  const started = performance.now();
  for (let index = 0; index < 20; index += 1) {
    encodeChunk(bytes.buffer);
  }
  const averageMs = (performance.now() - started) / 20;
  // Old string-concat path was multi-ms; keep the efficient path well under 2ms in Bun.
  expect(averageMs).toBeLessThan(2);
});

test("binary chunk frames round-trip without base64", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 250, 255]).buffer;
  const message = {
    type: "chunk" as const,
    fileId: "file-1",
    chunkIndex: 7,
    offset: 7 * MANIFEST_CHUNK_BYTES,
    bytes: payload,
    chunkDigest: "a".repeat(64),
  };
  const decoded = decodeBinaryChunk(encodeBinaryChunk(message));
  expect(decoded).toEqual(message);
});

test("binary chunk frames stay smaller than base64 JSON envelopes", () => {
  const payload = new Uint8Array(MANIFEST_CHUNK_BYTES);
  payload.fill(9);
  const message = {
    type: "chunk" as const,
    fileId: "file-1",
    chunkIndex: 0,
    offset: 0,
    bytes: payload.buffer,
    chunkDigest: "b".repeat(64),
  };
  const binarySize = encodeBinaryChunk(message).byteLength;
  const jsonSize = new TextEncoder().encode(
    JSON.stringify({
      type: "chunk",
      fileId: message.fileId,
      chunkIndex: message.chunkIndex,
      offset: message.offset,
      bytesBase64: encodeChunk(message.bytes),
      chunkDigest: message.chunkDigest,
    }),
  ).byteLength;
  expect(binarySize).toBeLessThan(jsonSize);
  expect(binarySize).toBeLessThan(MANIFEST_CHUNK_BYTES + 128);
});

test("binary relay chunk frames round-trip sequence and payload", () => {
  const payload = new Uint8Array([9, 8, 7, 6]).buffer;
  const chunk = {
    type: "chunk" as const,
    fileId: "file-1",
    chunkIndex: 3,
    offset: 3 * MANIFEST_CHUNK_BYTES,
    bytes: payload,
    chunkDigest: "c".repeat(64),
  };
  const decoded = decodeBinaryRelayChunkFrame(encodeBinaryRelayChunkFrame(11, chunk));
  expect(decoded).toEqual({ sequence: 11, message: chunk });
});

test("binary relay chunk frames stay smaller than base64 JSON relay envelopes", () => {
  const payload = new Uint8Array(MANIFEST_CHUNK_BYTES);
  payload.fill(4);
  const chunk = {
    type: "chunk" as const,
    fileId: "file-1",
    chunkIndex: 0,
    offset: 0,
    bytes: payload.buffer,
    chunkDigest: "d".repeat(64),
  };
  const binarySize = encodeBinaryRelayChunkFrame(0, chunk).byteLength;
  const jsonSize = new TextEncoder().encode(
    JSON.stringify({
      type: "relay-message",
      payload: {
        sequence: 0,
        message: {
          type: "chunk",
          fileId: chunk.fileId,
          chunkIndex: chunk.chunkIndex,
          offset: chunk.offset,
          bytesBase64: encodeChunk(chunk.bytes),
          chunkDigest: chunk.chunkDigest,
        },
      },
    }),
  ).byteLength;
  expect(binarySize).toBeLessThan(jsonSize);
  expect(binarySize).toBeLessThan(MANIFEST_CHUNK_BYTES + 160);
});
