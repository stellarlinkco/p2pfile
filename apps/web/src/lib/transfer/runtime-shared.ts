import type { FileManifestItem, TransferMode } from "@p2pfile/shared";
import type {
  BrowserSignalMessage,
  ForwardedSignalMessage,
  ReceiverRuntimeHandlers,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

const CHUNK_BYTES = 64 * 1024;

function configuredIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ];

  const turnUrl = import.meta.env?.VITE_TURN_URL;
  if (typeof turnUrl === "string" && turnUrl.length > 0) {
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
    __P2PFILE_TEST_FALLBACK__?: boolean;
  }
}

type ReceiverProtocolState = {
  manifest: FileManifestItem[];
  totalBytes: number;
  completedBytes: number;
  receivedFiles: number;
  currentFile: FileManifestItem | null;
  currentChunks: ArrayBuffer[];
  currentBytes: number;
};

export function relayAvailable() {
  return true;
}

export function preferRelayInTests() {
  return typeof window !== "undefined" && window.__P2PFILE_TEST_FALLBACK__ === true;
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

export async function awaitBufferedAmount(channel: RTCDataChannel) {
  if (channel.bufferedAmount < CHUNK_BYTES * 2) {
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  channel.bufferedAmountLowThreshold = CHUNK_BYTES;
  channel.addEventListener("bufferedamountlow", () => resolve(), { once: true });
  await promise;
}

export function sendSignal(ws: WebSocket, message: BrowserSignalMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function sendProtocolMessage(
  channel: RTCDataChannel,
  message: Exclude<TransferProtocolMessage, { type: "chunk" }>,
) {
  channel.send(JSON.stringify(message));
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

export function buildReceiverState(expectedManifest: FileManifestItem[]): ReceiverProtocolState {
  return {
    manifest: expectedManifest,
    totalBytes: expectedManifest.reduce((sum, file) => sum + file.size, 0),
    completedBytes: 0,
    receivedFiles: 0,
    currentFile: null,
    currentChunks: [],
    currentBytes: 0,
  };
}

export function handleProtocolMessage(
  message: TransferProtocolMessage,
  state: ReceiverProtocolState,
  handlers: ReceiverRuntimeHandlers,
) {
  if (message.type === "manifest") {
    state.manifest = message.files;
    state.totalBytes = message.totalBytes;
    handlers.onStatus("Receiving manifest");
    return;
  }

  if (message.type === "file-start") {
    state.currentFile = message.file;
    state.currentChunks = [];
    state.currentBytes = 0;
    handlers.onStatus(`Receiving ${message.file.name}`);
    return;
  }

  if (message.type === "chunk") {
    state.currentChunks.push(message.bytes);
    state.currentBytes += message.bytes.byteLength;
    handlers.onProgress({
      fileId: state.currentFile ? state.currentFile.id : message.fileId,
      fileName: state.currentFile ? state.currentFile.name : null,
      fileBytes: state.currentBytes,
      fileTotalBytes: state.currentFile ? state.currentFile.size : 0,
      completedBytes: state.completedBytes + state.currentBytes,
      totalBytes: state.totalBytes,
      completedFiles: state.receivedFiles,
      totalFiles: state.manifest.length,
    });
    return;
  }

  if (message.type === "file-end") {
    if (
      !state.currentFile ||
      state.currentBytes !== message.bytes ||
      state.currentBytes !== state.currentFile.size
    ) {
      throw new Error("File size verification failed.");
    }

    const blob = new Blob(state.currentChunks);
    state.completedBytes += state.currentBytes;
    state.receivedFiles += 1;
    handlers.onProgress({
      fileId: state.currentFile.id,
      fileName: state.currentFile.name,
      fileBytes: state.currentFile.size,
      fileTotalBytes: state.currentFile.size,
      completedBytes: state.completedBytes,
      totalBytes: state.totalBytes,
      completedFiles: state.receivedFiles,
      totalFiles: state.manifest.length,
    });
    handlers.onFileReceived({
      id: state.currentFile.id,
      name: state.currentFile.name,
      size: state.currentFile.size,
      blob,
      url: URL.createObjectURL(blob),
    });
    state.currentFile = null;
    state.currentChunks = [];
    state.currentBytes = 0;
    return;
  }

  if (state.completedBytes !== message.totalBytes || state.completedBytes !== state.totalBytes) {
    throw new Error("Session size verification failed.");
  }

  handlers.onComplete();
}

export function makePeerConnection(
  ws: WebSocket,
  handlers: SenderRuntimeHandlers | ReceiverRuntimeHandlers,
  initialStatus: string,
) {
  const pc = new RTCPeerConnection({ iceServers: configuredIceServers() });
  handlers.onStatus(initialStatus);

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendSignal(ws, { type: "ice-candidate", payload: event.candidate.toJSON() });
    }
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      applyMode("direct", handlers);
      sendSignal(ws, { type: "mode", payload: { mode: "direct" } });
      return;
    }

    if (pc.iceConnectionState === "failed" && relayAvailable()) {
      applyMode("relay", handlers);
      sendSignal(ws, { type: "mode", payload: { mode: "relay" } });
    }
  });

  return pc;
}
