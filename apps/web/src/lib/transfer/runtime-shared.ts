import type { TransferMode } from "@p2pfile/shared";
import type {
  BrowserSignalMessage,
  ForwardedSignalMessage,
  ReceiverRuntimeHandlers,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

const CHUNK_BYTES = 64 * 1024;

function configuredTurnUrl() {
  const turnUrl = import.meta.env?.VITE_TURN_URL;
  return typeof turnUrl === "string" && turnUrl.length > 0 ? turnUrl : null;
}

export function turnConfigured() {
  return configuredTurnUrl() !== null;
}

function configuredIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ];

  const turnUrl = configuredTurnUrl();
  if (turnUrl !== null) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env?.VITE_TURN_USERNAME,
      credential: import.meta.env?.VITE_TURN_CREDENTIAL,
    });
  }

  return servers;
}

declare global {
  interface Window {
    __P2PFILE_FORCE_DIRECT_FAIL__?: boolean;
    __P2PFILE_TEST_FALLBACK__?: boolean;
  }
}

export { buildReceiverState, handleProtocolMessage } from "./receiver-protocol";

export function relayAvailable() {
  return true;
}

export function preferRelayInTests() {
  return typeof window !== "undefined" && window.__P2PFILE_TEST_FALLBACK__ === true;
}

export function forceDirectFail() {
  return typeof window !== "undefined" && window.__P2PFILE_FORCE_DIRECT_FAIL__ === true;
}

export function awaitSocketOpen(ws: WebSocket) {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("Signal socket failed to open.")), {
    once: true,
  });
  return promise;
}

export function awaitIceComplete(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  const listener = () => {
    if (pc.iceGatheringState === "complete") {
      pc.removeEventListener("icegatheringstatechange", listener);
      resolve();
    }
  };
  pc.addEventListener("icegatheringstatechange", listener);
  return promise;
}

function dataChannelClosedError() {
  return new Error("Data channel is not open.");
}

function isNativeDataChannelClosedError(error: unknown) {
  return (
    error instanceof DOMException &&
    error.name === "InvalidStateError" &&
    error.message.includes("RTCDataChannel.readyState")
  );
}

export function assertDataChannelOpen(channel: RTCDataChannel) {
  if (channel.readyState !== "open") {
    throw dataChannelClosedError();
  }
}

export async function awaitBufferedAmount(channel: RTCDataChannel) {
  assertDataChannelOpen(channel);
  if (channel.bufferedAmount < CHUNK_BYTES * 2) {
    return;
  }

  const { promise, reject, resolve } = Promise.withResolvers<void>();
  const onBufferedAmountLow = () => {
    channel.removeEventListener("close", onClose);
    resolve();
  };
  const onClose = () => {
    channel.removeEventListener("bufferedamountlow", onBufferedAmountLow);
    reject(dataChannelClosedError());
  };

  channel.bufferedAmountLowThreshold = CHUNK_BYTES;
  channel.addEventListener("bufferedamountlow", onBufferedAmountLow, { once: true });
  channel.addEventListener("close", onClose, { once: true });
  await promise;
  assertDataChannelOpen(channel);
}

export function sendSignal(ws: WebSocket, message: BrowserSignalMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function sendDataChannelPayload(channel: RTCDataChannel, data: string | ArrayBuffer) {
  assertDataChannelOpen(channel);
  try {
    if (typeof data === "string") {
      channel.send(data);
    } else {
      channel.send(data);
    }
  } catch (error) {
    if (isNativeDataChannelClosedError(error)) {
      throw dataChannelClosedError();
    }
    throw error;
  }
}

export function sendProtocolMessage(
  channel: RTCDataChannel,
  message: Exclude<TransferProtocolMessage, { type: "chunk" }>,
) {
  sendDataChannelPayload(channel, JSON.stringify(message));
}

export function parseSignalMessage(raw: MessageEvent<string>) {
  if (typeof raw.data !== "string") {
    return null;
  }

  try {
    return JSON.parse(raw.data) as ForwardedSignalMessage;
  } catch {
    return null;
  }
}

export function parseProtocolMessage(data: string) {
  try {
    return JSON.parse(data) as TransferProtocolMessage;
  } catch {
    return null;
  }
}

export function applyMode(
  mode: TransferMode,
  handlers: SenderRuntimeHandlers | ReceiverRuntimeHandlers,
) {
  handlers.onMode(mode);
  handlers.onStatus(mode === "direct" ? "Direct Transfer connected" : "Relayed Transfer connected");
}

export type PeerConnectionOptions = {
  iceTransportPolicy?: RTCIceTransportPolicy;
  connectedMode?: TransferMode;
};

export function makePeerConnection(
  ws: WebSocket,
  handlers: SenderRuntimeHandlers | ReceiverRuntimeHandlers,
  initialStatus: string,
  options?: PeerConnectionOptions,
) {
  const connectedMode = options?.connectedMode ?? "direct";
  const config: RTCConfiguration = { iceServers: configuredIceServers() };
  if (options?.iceTransportPolicy) {
    config.iceTransportPolicy = options.iceTransportPolicy;
  }
  const pc = new RTCPeerConnection(config);
  handlers.onStatus(initialStatus);

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendSignal(ws, { type: "ice-candidate", payload: event.candidate.toJSON() });
    }
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      applyMode(connectedMode, handlers);
      if (connectedMode === "direct") {
        sendSignal(ws, { type: "mode", payload: { mode: "direct" } });
      }
      return;
    }
  });

  return pc;
}
