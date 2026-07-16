import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import {
  MAX_RELAY_RECOVERY_ATTEMPTS,
  relayRecoveryExhausted,
  startSenderRuntime,
} from "./sender-runtime";
import type { BrowserSignalMessage, SenderRuntimeHandlers } from "./types";

// Minimal harness copied for recovery-budget isolation (keeps sender-runtime.test under line cap).
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: Array<BrowserSignalMessage | ArrayBuffer | string> = [];
  private listeners = new Map<string, Set<(event: MessageEvent | CloseEvent) => void>>();
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatch("open"));
  }
  addEventListener(type: string, listener: (event: MessageEvent | CloseEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: MessageEvent | CloseEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: BrowserSignalMessage | ArrayBuffer | string) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  receive(message: BrowserSignalMessage) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) } as MessageEvent);
    }
  }
  relayMessageCount() {
    return this.sent.filter(
      (m) =>
        (typeof m !== "string" && !(m instanceof ArrayBuffer) && m.type === "relay-message") ||
        m instanceof ArrayBuffer,
    ).length;
  }
  private dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({} as MessageEvent);
  }
  close() {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) {
      listener({ code: 1000, reason: "" } as CloseEvent);
    }
  }
}
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  iceConnectionState = "new";
  connectionState = "new";
  signalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  channels: Array<{ readyState: string; binaryType: string; close: () => void; open: () => void }> =
    [];
  constructor(public config: RTCConfiguration = {}) {
    FakePeerConnection.instances.push(this);
  }
  createDataChannel() {
    const channel = {
      readyState: "connecting",
      binaryType: "blob",
      close() {
        this.readyState = "closed";
      },
      open() {
        this.readyState = "open";
      },
      addEventListener() {},
      removeEventListener() {},
      send() {},
    };
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }
  createOffer = async () => ({ type: "offer", sdp: "v=0" });
  setLocalDescription = async (desc: RTCSessionDescriptionInit) => {
    this.localDescription = desc;
  };
  setRemoteDescription = async () => undefined;
  addIceCandidate = async () => undefined;
  addEventListener() {}
  close() {
    this.signalingState = "closed";
  }
  failIce() {
    this.iceConnectionState = "failed";
    this.connectionState = "failed";
  }
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await Bun.sleep(0);
}

async function withRelayOnlyWindow(run: () => Promise<void>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __P2PFILE_TEST_FALLBACK__: true, location: { origin: "http://localhost" } },
  });
  try {
    await run();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("relay recovery budget helpers bound reconnect attempts", () => {
  expect(relayRecoveryExhausted(MAX_RELAY_RECOVERY_ATTEMPTS)).toBe(false);
  expect(relayRecoveryExhausted(MAX_RELAY_RECOVERY_ATTEMPTS + 1)).toBe(true);
});

test("relay recovery exhausts after repeated peer-unavailable nacks without progress", async () => {
  const previousPeer = globalThis.RTCPeerConnection;
  const previousWs = globalThis.WebSocket;
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const errors: string[] = [];
  const handlers: SenderRuntimeHandlers = {
    onStatus() {},
    onMode() {},
    onProgress() {},
    onComplete() {},
    onError(message) {
      errors.push(message);
    },
  };
  try {
    await withRelayOnlyWindow(async () => {
      const file = new File([new Uint8Array(MANIFEST_CHUNK_BYTES)], "budget.bin");
      const manifest = [{ id: "file-1", name: file.name, size: file.size, mimeType: file.type }];
      const runtime = await startSenderRuntime(
        "session-relay-budget",
        "sender-token",
        [file],
        manifest,
        handlers,
      );
      await settle();
      const socket = FakeWebSocket.instances[0];
      if (!socket) throw new Error("missing socket");
      for (let attempt = 0; attempt < MAX_RELAY_RECOVERY_ATTEMPTS + 1; attempt += 1) {
        socket.receive({ type: "relay-ready", payload: {} });
        await settle();
        socket.receive({
          type: "relay-nack",
          payload: { sequence: 0, reason: "peer-unavailable" },
        });
        await settle();
      }
      expect(
        errors.some((message) =>
          message.includes(
            `Relay transfer failed after ${MAX_RELAY_RECOVERY_ATTEMPTS} reconnect attempts.`,
          ),
        ),
      ).toBe(true);
      runtime.stop();
    });
  } finally {
    globalThis.RTCPeerConnection = previousPeer;
    globalThis.WebSocket = previousWs;
  }
});
