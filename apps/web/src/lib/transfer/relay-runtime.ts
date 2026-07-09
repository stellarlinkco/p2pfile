import type { RelayProtocolMessage, TransferProtocolMessage } from "./types";

export const CLOUDFLARE_WEBSOCKET_MESSAGE_LIMIT_BYTES = 32 * 1024 * 1024;

type RelayEnvelope = {
  type: "relay-message";
  payload: {
    sequence: number;
    message: RelayProtocolMessage;
  };
};

export function relayEnvelopeSizeBytes(envelope: RelayEnvelope) {
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}

export function assertRelayEnvelopeFitsCloudflareLimit(
  envelope: RelayEnvelope,
  limitBytes = CLOUDFLARE_WEBSOCKET_MESSAGE_LIMIT_BYTES,
) {
  if (relayEnvelopeSizeBytes(envelope) >= limitBytes) {
    throw new Error("Relay message exceeds Cloudflare WebSocket receive limit.");
  }
}

export function encodeChunk(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  // Prefer browser-native btoa. Keep fromCharCode batches small: large spreads
  // (e.g. 32 KiB) are catastrophically slow in Chromium and can stall the UI.
  if (typeof btoa === "function") {
    const chunkSize = 0x2000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, slice as unknown as number[]);
    }
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  throw new Error("No base64 encoder available.");
}

export function decodeChunk(bytesBase64: string) {
  if (typeof atob === "function") {
    const binary = atob(bytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }
  if (typeof Buffer !== "undefined") {
    const decoded = Buffer.from(bytesBase64, "base64");
    return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
  }
  throw new Error("No base64 decoder available.");
}

const BINARY_CHUNK_MAGIC = 0x50;
const BINARY_CHUNK_VERSION = 1;
const BINARY_CHUNK_DIGEST_BYTES = 64;

/**
 * Direct DataChannel chunk frame (FastSend-style binary payload):
 * magic(1) version(1) fileIdLen(u16) fileId(utf8)
 * chunkIndex(u32) offset(u64) digest(64 ascii) payloadLen(u32) payload
 */
export function encodeBinaryChunk(
  message: Extract<TransferProtocolMessage, { type: "chunk" }>,
): ArrayBuffer {
  const fileIdBytes = new TextEncoder().encode(message.fileId);
  const digestBytes = new TextEncoder().encode(message.chunkDigest);
  if (digestBytes.byteLength !== BINARY_CHUNK_DIGEST_BYTES) {
    throw new Error("Chunk digest must be 64 hex characters.");
  }
  const payload = new Uint8Array(message.bytes);
  const headerBytes = 1 + 1 + 2 + fileIdBytes.byteLength + 4 + 8 + BINARY_CHUNK_DIGEST_BYTES + 4;
  const buffer = new ArrayBuffer(headerBytes + payload.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  view.setUint8(offset, BINARY_CHUNK_MAGIC);
  offset += 1;
  view.setUint8(offset, BINARY_CHUNK_VERSION);
  offset += 1;
  view.setUint16(offset, fileIdBytes.byteLength, false);
  offset += 2;
  bytes.set(fileIdBytes, offset);
  offset += fileIdBytes.byteLength;
  view.setUint32(offset, message.chunkIndex >>> 0, false);
  offset += 4;
  view.setBigUint64(offset, BigInt(message.offset), false);
  offset += 8;
  bytes.set(digestBytes, offset);
  offset += BINARY_CHUNK_DIGEST_BYTES;
  view.setUint32(offset, payload.byteLength, false);
  offset += 4;
  bytes.set(payload, offset);
  return buffer;
}

export function decodeBinaryChunk(
  buffer: ArrayBuffer | ArrayBufferView,
): Extract<TransferProtocolMessage, { type: "chunk" }> | null {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.byteLength < 1 + 1 + 2 + 4 + 8 + BINARY_CHUNK_DIGEST_BYTES + 4) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  if (view.getUint8(offset) !== BINARY_CHUNK_MAGIC) return null;
  offset += 1;
  if (view.getUint8(offset) !== BINARY_CHUNK_VERSION) return null;
  offset += 1;
  const fileIdLen = view.getUint16(offset, false);
  offset += 2;
  if (offset + fileIdLen + 4 + 8 + BINARY_CHUNK_DIGEST_BYTES + 4 > bytes.byteLength) {
    return null;
  }
  const fileId = new TextDecoder().decode(bytes.subarray(offset, offset + fileIdLen));
  offset += fileIdLen;
  const chunkIndex = view.getUint32(offset, false);
  offset += 4;
  const chunkOffset = Number(view.getBigUint64(offset, false));
  offset += 8;
  const chunkDigest = new TextDecoder().decode(
    bytes.subarray(offset, offset + BINARY_CHUNK_DIGEST_BYTES),
  );
  offset += BINARY_CHUNK_DIGEST_BYTES;
  const payloadLen = view.getUint32(offset, false);
  offset += 4;
  if (offset + payloadLen > bytes.byteLength) return null;
  const payloadBytes = new Uint8Array(payloadLen);
  payloadBytes.set(bytes.subarray(offset, offset + payloadLen));
  const payload = payloadBytes.buffer;
  return {
    type: "chunk",
    fileId,
    chunkIndex,
    offset: chunkOffset,
    bytes: payload,
    chunkDigest,
  };
}

const BINARY_RELAY_MAGIC = 0x52; // 'R'
const BINARY_RELAY_VERSION = 1;

/**
 * Relay WebSocket binary frame for chunk payloads only:
 * magic(1) version(1) sequence(u32) + Direct binary chunk frame.
 * Control/non-chunk relay messages stay JSON for schema compatibility.
 */
export function encodeBinaryRelayChunkFrame(
  sequence: number,
  message: Extract<TransferProtocolMessage, { type: "chunk" }>,
): ArrayBuffer {
  const chunk = new Uint8Array(encodeBinaryChunk(message));
  const buffer = new ArrayBuffer(1 + 1 + 4 + chunk.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint8(0, BINARY_RELAY_MAGIC);
  view.setUint8(1, BINARY_RELAY_VERSION);
  view.setUint32(2, sequence >>> 0, false);
  bytes.set(chunk, 6);
  return buffer;
}

export function decodeBinaryRelayChunkFrame(
  buffer: ArrayBuffer | ArrayBufferView,
): { sequence: number; message: Extract<TransferProtocolMessage, { type: "chunk" }> } | null {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.byteLength < 1 + 1 + 4 + 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BINARY_RELAY_MAGIC) return null;
  if (view.getUint8(1) !== BINARY_RELAY_VERSION) return null;
  const sequence = view.getUint32(2, false);
  const chunk = decodeBinaryChunk(bytes.subarray(6));
  if (!chunk) return null;
  return { sequence, message: chunk };
}

export function toRelayMessage(message: TransferProtocolMessage): RelayProtocolMessage {
  if (message.type !== "chunk") {
    return message;
  }

  return {
    type: "chunk",
    fileId: message.fileId,
    chunkIndex: message.chunkIndex,
    offset: message.offset,
    bytesBase64: encodeChunk(message.bytes),
    chunkDigest: message.chunkDigest,
  };
}

export function fromRelayMessage(message: RelayProtocolMessage): TransferProtocolMessage {
  if (message.type !== "chunk") {
    return message;
  }

  return {
    type: "chunk",
    fileId: message.fileId,
    chunkIndex: message.chunkIndex,
    offset: message.offset,
    bytes: decodeChunk(message.bytesBase64),
    chunkDigest: message.chunkDigest,
  };
}
