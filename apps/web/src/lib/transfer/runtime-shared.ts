import type { TransferMode } from "@p2pfile/shared";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import {
  decodeBinaryChunk,
  decodeBinaryRelayChunkFrame,
  decodeChunk,
  encodeBinaryChunk,
} from "./relay-runtime";
import type {
  BrowserSignalMessage,
  ForwardedSignalMessage,
  ReceiverRuntimeHandlers,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
  TransportDiagnostics,
} from "./types";

// Allow a multi-chunk pipeline before applying send-side SCTP backpressure.
// Commit-window backpressure (maxInFlightBytes) remains the primary control.
const DATA_CHANNEL_HIGH_WATER_BYTES = MANIFEST_CHUNK_BYTES * 16;

function configuredTurnUrl() {
  const turnUrl = import.meta.env?.VITE_TURN_URL;
  return typeof turnUrl === "string" && turnUrl.length > 0 ? turnUrl : null;
}

export function turnConfigured() {
  return configuredTurnUrl() !== null;
}

function configuredStunServers(): RTCIceServer[] {
  const stunUrl = import.meta.env?.VITE_STUN_URL;
  if (typeof stunUrl === "string" && stunUrl.length > 0) {
    return [{ urls: stunUrl }];
  }
  return [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:global.stun.twilio.com:3478" }];
}

function configuredIceServers(): RTCIceServer[] {
  const servers = configuredStunServers();

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
  if (channel.bufferedAmount < DATA_CHANNEL_HIGH_WATER_BYTES) {
    return;
  }

  // Adaptive threshold inspired by FastSend: keep ~16 chunks buffered when
  // the window is still large, otherwise drain fully.
  channel.bufferedAmountLowThreshold = Math.min(
    Math.floor(DATA_CHANNEL_HIGH_WATER_BYTES / 2),
    MANIFEST_CHUNK_BYTES * 16,
  );

  while (channel.readyState === "open" && channel.bufferedAmount >= DATA_CHANNEL_HIGH_WATER_BYTES) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onBufferedAmountLow);
        channel.removeEventListener("close", onClose);
        action();
      };
      const onBufferedAmountLow = () => settle(() => resolve());
      const onClose = () => settle(() => reject(dataChannelClosedError()));
      // Polling backup: bufferedamountlow can be missed if the buffer drains
      // between the threshold check and listener registration.
      const timer = globalThis.setTimeout(() => settle(() => resolve()), 32);

      channel.addEventListener("bufferedamountlow", onBufferedAmountLow, { once: true });
      channel.addEventListener("close", onClose, { once: true });
      if (channel.bufferedAmount < DATA_CHANNEL_HIGH_WATER_BYTES) {
        settle(() => resolve());
      }
    });
  }

  assertDataChannelOpen(channel);
}

/**
 * FastSend-style send pump: fire the frame immediately, then wait only when
 * SCTP send buffer is above the high-water mark.
 */
export async function pumpDataChannelSend(
  channel: RTCDataChannel,
  data: string | ArrayBuffer,
): Promise<void> {
  sendDataChannelPayload(channel, data);
  await awaitBufferedAmount(channel);
}

export function sendSignal(ws: WebSocket, message: BrowserSignalMessage | ArrayBuffer | string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (typeof message === "string" || message instanceof ArrayBuffer) {
    ws.send(message);
    return;
  }
  ws.send(JSON.stringify(message));
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

export function sendProtocolMessage(channel: RTCDataChannel, message: TransferProtocolMessage) {
  if (message.type === "chunk") {
    sendDataChannelPayload(channel, encodeBinaryChunk(message));
    return;
  }
  sendDataChannelPayload(channel, JSON.stringify(message));
}

export async function sendProtocolMessagePumped(
  channel: RTCDataChannel,
  message: TransferProtocolMessage,
) {
  if (message.type === "chunk") {
    await pumpDataChannelSend(channel, encodeBinaryChunk(message));
    return;
  }
  await pumpDataChannelSend(channel, JSON.stringify(message));
}

export type ParsedSignalWire =
  | { kind: "json"; message: ForwardedSignalMessage }
  | {
      kind: "binary-relay-chunk";
      sequence: number;
      message: Extract<TransferProtocolMessage, { type: "chunk" }>;
    };

export function parseSignalWire(raw: MessageEvent | { data: unknown }): ParsedSignalWire | null {
  if (typeof raw.data === "string") {
    try {
      return { kind: "json", message: JSON.parse(raw.data) as ForwardedSignalMessage };
    } catch {
      return null;
    }
  }

  if (raw.data instanceof ArrayBuffer || ArrayBuffer.isView(raw.data)) {
    const decoded = decodeBinaryRelayChunkFrame(raw.data);
    if (!decoded) return null;
    return {
      kind: "binary-relay-chunk",
      sequence: decoded.sequence,
      message: decoded.message,
    };
  }

  return null;
}

export async function parseSignalBlob(blob: Blob): Promise<ParsedSignalWire | null> {
  const data = await blob.arrayBuffer();
  const binary = parseSignalWire({ data });
  if (binary) return binary;
  return parseSignalWire({ data: new TextDecoder().decode(data) });
}

export function parseSignalMessage(
  raw: MessageEvent | { data: unknown },
): ForwardedSignalMessage | null {
  const parsed = parseSignalWire(raw);
  if (!parsed) return null;
  if (parsed.kind === "json") return parsed.message;
  return {
    type: "relay-message",
    payload: {
      sequence: parsed.sequence,
      message: {
        type: "chunk",
        fileId: parsed.message.fileId,
        chunkIndex: parsed.message.chunkIndex,
        offset: parsed.message.offset,
        bytesBase64: "",
        chunkDigest: parsed.message.chunkDigest,
      },
    },
  };
}

export function parseProtocolMessage(data: string | ArrayBuffer | ArrayBufferView) {
  if (typeof data !== "string") {
    return decodeBinaryChunk(data);
  }
  try {
    const parsed = JSON.parse(data) as
      | TransferProtocolMessage
      | (Omit<TransferProtocolMessage & { type: "chunk" }, "bytes"> & { bytesBase64: string });
    if (parsed.type === "chunk" && "bytesBase64" in parsed) {
      return { ...parsed, bytes: decodeChunk(parsed.bytesBase64) } as TransferProtocolMessage;
    }
    return parsed as TransferProtocolMessage;
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

export type { TransportDiagnostics } from "./types";
export async function collectTransportDiagnostics(
  pc: RTCPeerConnection,
  mode: TransferMode,
  iceTransportPolicy?: RTCIceTransportPolicy,
): Promise<TransportDiagnostics> {
  let localCandidateType: string | null = null;
  let remoteCandidateType: string | null = null;
  let protocol: string | null = null;
  try {
    const stats = await pc.getStats();
    let selectedPairId: string | null = null;
    const reports = new Map<string, RTCStats>();
    stats.forEach((report) => {
      reports.set(report.id, report);
      if (report.type === "transport") {
        const selected = (report as RTCStats & { selectedCandidatePairId?: string })
          .selectedCandidatePairId;
        if (selected) selectedPairId = selected;
      }
      if (
        report.type === "candidate-pair" &&
        (report as RTCStats & { selected?: boolean; nominated?: boolean }).selected
      ) {
        selectedPairId = report.id;
      }
    });
    const pair = selectedPairId ? reports.get(selectedPairId) : null;
    if (pair && pair.type === "candidate-pair") {
      const pairReport = pair as RTCStats & {
        localCandidateId?: string;
        remoteCandidateId?: string;
      };
      const local = pairReport.localCandidateId
        ? (reports.get(pairReport.localCandidateId) as RTCStats & {
            candidateType?: string;
            protocol?: string;
          })
        : null;
      const remote = pairReport.remoteCandidateId
        ? (reports.get(pairReport.remoteCandidateId) as RTCStats & {
            candidateType?: string;
            protocol?: string;
          })
        : null;
      localCandidateType = local?.candidateType ?? null;
      remoteCandidateType = remote?.candidateType ?? null;
      protocol = local?.protocol ?? remote?.protocol ?? null;
    }
  } catch {
    // getStats can fail on closed connections; diagnostics stay null.
  }
  return {
    mode,
    localCandidateType,
    remoteCandidateType,
    protocol,
    iceTransportPolicy: iceTransportPolicy ?? null,
  };
}

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
      void collectTransportDiagnostics(pc, connectedMode, options?.iceTransportPolicy).then(
        (diagnostics) => {
          handlers.onTransportDiagnostics?.(diagnostics);
          if (typeof console !== "undefined") {
            console.info("[p2pfile] transport", diagnostics);
          }
        },
      );
      return;
    }
  });

  return pc;
}
