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
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeChunk(bytesBase64: string) {
  const binary = atob(bytesBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
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
