import type { RelayProtocolMessage, TransferProtocolMessage } from "./types";

function encodeChunk(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeChunk(bytesBase64: string) {
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
    bytesBase64: encodeChunk(message.bytes),
  };
}

export function fromRelayMessage(message: RelayProtocolMessage): TransferProtocolMessage {
  if (message.type !== "chunk") {
    return message;
  }

  return {
    type: "chunk",
    fileId: message.fileId,
    bytes: decodeChunk(message.bytesBase64),
  };
}
