import { expect, test } from "bun:test";
import {
  awaitBufferedAmount,
  buildReceiverState,
  handleProtocolMessage,
  makePeerConnection,
  turnConfigured,
} from "./runtime-shared";
import type { BrowserSignalMessage, ReceiverRuntimeHandlers } from "./types";

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  readonly config: RTCConfiguration;
  iceConnectionState = "new";
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function withFakePeerConnection<T>(run: () => T): T {
  const previous = globalThis.RTCPeerConnection;
  FakePeerConnection.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  try {
    return run();
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
}

function fakeSignalSocket(sent: BrowserSignalMessage[]) {
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(JSON.parse(data) as BrowserSignalMessage);
    },
  } as unknown as WebSocket;
}

function withTurnUrl<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.VITE_TURN_URL;
  if (value === undefined) {
    delete process.env.VITE_TURN_URL;
  } else {
    process.env.VITE_TURN_URL = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.VITE_TURN_URL;
    } else {
      process.env.VITE_TURN_URL = previous;
    }
  }
}

test("a relay-disclosed peer connection reports relay mode without signaling a mode switch", () => {
  withFakePeerConnection(() => {
    const sent: BrowserSignalMessage[] = [];
    const modes: string[] = [];
    const handlers = receiverHandlersWith({
      onMode(mode) {
        modes.push(mode);
      },
    });

    makePeerConnection(fakeSignalSocket(sent), handlers, "Connecting", {
      iceTransportPolicy: "relay",
      connectedMode: "relay",
    });

    const pc = FakePeerConnection.instances[0];
    if (!pc) throw new Error("Peer connection was not created.");
    expect(pc.config.iceTransportPolicy).toBe("relay");

    pc.iceConnectionState = "connected";
    pc.dispatch("iceconnectionstatechange");

    expect(modes).toEqual(["relay"]);
    expect(sent.filter((message) => message.type === "mode")).toEqual([]);
  });
});

test("a default peer connection still announces direct mode when connected", () => {
  withFakePeerConnection(() => {
    const sent: BrowserSignalMessage[] = [];
    const modes: string[] = [];
    const handlers = receiverHandlersWith({
      onMode(mode) {
        modes.push(mode);
      },
    });

    makePeerConnection(fakeSignalSocket(sent), handlers, "Connecting");

    const pc = FakePeerConnection.instances[0];
    if (!pc) throw new Error("Peer connection was not created.");
    expect(pc.config.iceTransportPolicy).toBeUndefined();

    pc.iceConnectionState = "connected";
    pc.dispatch("iceconnectionstatechange");

    expect(modes).toEqual(["direct"]);
    expect(sent).toEqual([{ type: "mode", payload: { mode: "direct" } }]);
  });
});

test("turnConfigured reflects the VITE_TURN_URL environment", () => {
  expect(withTurnUrl(undefined, () => turnConfigured())).toBe(false);
  expect(withTurnUrl("", () => turnConfigured())).toBe(false);
  expect(withTurnUrl("turn:turn.example.com:3478", () => turnConfigured())).toBe(true);
});

function receiverHandlersWith(
  overrides: Partial<ReceiverRuntimeHandlers>,
): ReceiverRuntimeHandlers {
  return {
    onStatus() {},
    onMode() {},
    onProgress() {},
    onComplete() {},
    onError() {},
    onFileReceived() {},
    onEnded() {},
    ...overrides,
  };
}

function bytesOf(content: string) {
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}

async function sha256Hex(content: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("file-end with a matching digest completes the file and the session", async () => {
  const manifestItem = { id: "file-1", name: "alpha.txt", size: 5 };
  const state = buildReceiverState([manifestItem]);
  const receivedFileIds: string[] = [];
  let completeCalls = 0;
  const handlers = receiverHandlersWith({
    onFileReceived(file) {
      receivedFileIds.push(file.id);
    },
    onComplete() {
      completeCalls += 1;
    },
  });

  await handleProtocolMessage({ type: "file-start", file: manifestItem }, state, handlers);
  await handleProtocolMessage(
    { type: "chunk", fileId: "file-1", bytes: bytesOf("alpha") },
    state,
    handlers,
  );
  await handleProtocolMessage(
    { type: "file-end", fileId: "file-1", bytes: 5, digest: await sha256Hex("alpha") },
    state,
    handlers,
  );
  await handleProtocolMessage({ type: "complete", totalBytes: 5 }, state, handlers);

  expect(receivedFileIds).toEqual(["file-1"]);
  expect(completeCalls).toBe(1);
});

test("session never completes while a file failed digest verification", async () => {
  const manifestItem = { id: "file-1", name: "alpha.txt", size: 5 };
  const state = buildReceiverState([manifestItem]);
  let completeCalls = 0;
  const handlers = receiverHandlersWith({
    onComplete() {
      completeCalls += 1;
    },
  });

  await handleProtocolMessage({ type: "file-start", file: manifestItem }, state, handlers);
  await handleProtocolMessage(
    { type: "chunk", fileId: "file-1", bytes: bytesOf("alpha") },
    state,
    handlers,
  );
  await expect(
    handleProtocolMessage(
      { type: "file-end", fileId: "file-1", bytes: 5, digest: "0".repeat(64) },
      state,
      handlers,
    ),
  ).rejects.toThrow("File integrity verification failed.");

  await handleProtocolMessage({ type: "complete", totalBytes: 5 }, state, handlers);
  expect(completeCalls).toBe(0);
});

test("file-end with a mismatched digest fails the file transfer", async () => {
  const manifestItem = { id: "file-1", name: "alpha.txt", size: 5 };
  const state = buildReceiverState([manifestItem]);
  const receivedFileIds: string[] = [];
  const handlers = receiverHandlersWith({
    onFileReceived(file) {
      receivedFileIds.push(file.id);
    },
  });

  await handleProtocolMessage({ type: "file-start", file: manifestItem }, state, handlers);
  await handleProtocolMessage(
    { type: "chunk", fileId: "file-1", bytes: bytesOf("alpha") },
    state,
    handlers,
  );

  await expect(
    handleProtocolMessage(
      { type: "file-end", fileId: "file-1", bytes: 5, digest: "0".repeat(64) },
      state,
      handlers,
    ),
  ).rejects.toThrow("File integrity verification failed.");
  expect(receivedFileIds).toEqual([]);
});

test("manifest mismatch freezes receiver before completion", async () => {
  const manifestItem = { id: "file-1", name: "alpha.txt", size: 5 };
  const state = buildReceiverState([manifestItem]);
  let completeCalls = 0;
  const handlers = receiverHandlersWith({
    onComplete() {
      completeCalls += 1;
    },
  });

  await expect(
    handleProtocolMessage(
      {
        type: "manifest",
        files: [{ id: "file-1", name: "renamed.txt", size: 5 }],
        totalBytes: 5,
      },
      state,
      handlers,
    ),
  ).rejects.toThrow("Session manifest verification failed.");

  await handleProtocolMessage({ type: "complete", totalBytes: 5 }, state, handlers);
  expect(completeCalls).toBe(0);
});

test("out-of-order file-start freezes receiver before completion", async () => {
  const manifest = [
    { id: "file-1", name: "alpha.txt", size: 5 },
    { id: "file-2", name: "beta.txt", size: 4 },
  ];
  const state = buildReceiverState(manifest);
  let completeCalls = 0;
  const handlers = receiverHandlersWith({
    onComplete() {
      completeCalls += 1;
    },
  });

  const nextFile = manifest[1];
  if (!nextFile) {
    throw new Error("Expected second manifest entry.");
  }

  await expect(
    handleProtocolMessage({ type: "file-start", file: nextFile }, state, handlers),
  ).rejects.toThrow("Sender sent files out of order.");

  await handleProtocolMessage({ type: "complete", totalBytes: 9 }, state, handlers);
  expect(completeCalls).toBe(0);
});

test("awaitBufferedAmount rejects when channel closes before draining", async () => {
  const listeners = new Map<string, Set<() => void>>();
  const channel = {
    bufferedAmount: 128 * 1024,
    bufferedAmountLowThreshold: 0,
    readyState: "open",
    addEventListener(type: string, listener: () => void) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as RTCDataChannel;

  const pending = awaitBufferedAmount(channel);
  for (const listener of listeners.get("close") ?? []) {
    listener();
  }

  await expect(pending).rejects.toThrow("Data channel is not open.");
});
