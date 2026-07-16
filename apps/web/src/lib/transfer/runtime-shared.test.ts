import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { createSha256Digest } from "./digest";
import type { LargeFileSinkBackend } from "./receiver-opfs-client";
import { opfsPartName } from "./receiver-opfs-worker-protocol";
import { setLargeFileSinkFactoryForTests } from "./receiver-sinks";
import {
  buildReceiverState,
  handleProtocolMessage,
  makePeerConnection,
  receiverResumeProgress,
  sendSignal,
  trySendSignal,
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

function withStunUrl<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.VITE_STUN_URL;
  if (value === undefined) {
    delete process.env.VITE_STUN_URL;
  } else {
    process.env.VITE_STUN_URL = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.VITE_STUN_URL;
    } else {
      process.env.VITE_STUN_URL = previous;
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

test("VITE_STUN_URL replaces public STUN servers for deterministic environments", () => {
  withFakePeerConnection(() => {
    withTurnUrl(undefined, () => {
      withStunUrl("stun:127.0.0.1:3478", () => {
        makePeerConnection(fakeSignalSocket([]), receiverHandlersWith({}), "Connecting");
      });
    });
    expect(FakePeerConnection.instances[0]?.config.iceServers).toEqual([
      { urls: "stun:127.0.0.1:3478" },
    ]);
  });
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
async function sha256Buffer(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function repeatedByte(byte: number, length: number) {
  const bytes = new Uint8Array(length);
  bytes.fill(byte);
  return bytes.buffer;
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

  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    handlers,
  );
  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 0,
      offset: 0,
      bytes: bytesOf("alpha"),
      chunkDigest: await sha256Hex("alpha"),
    },
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
test("repeated file-start at committed offset preserves the in-memory sink", async () => {
  const manifestItem = {
    id: "file-1",
    name: "small.bin",
    size: MANIFEST_CHUNK_BYTES + 5,
    mimeType: "application/octet-stream",
  };
  const state = buildReceiverState([manifestItem]);
  const receivedBlobs: Blob[] = [];
  const handlers = receiverHandlersWith({
    onFileReceived(file) {
      receivedBlobs.push(file.blob);
    },
  });
  const firstChunk = repeatedByte(0x61, MANIFEST_CHUNK_BYTES);
  const tailChunk = bytesOf("tail!");
  const fileDigest = await sha256Buffer(await new Blob([firstChunk, tailChunk]).arrayBuffer());

  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    handlers,
  );
  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 0,
      offset: 0,
      bytes: firstChunk,
      chunkDigest: await sha256Buffer(firstChunk),
    },
    state,
    handlers,
  );
  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: MANIFEST_CHUNK_BYTES },
    state,
    handlers,
  );
  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 1,
      offset: MANIFEST_CHUNK_BYTES,
      bytes: tailChunk,
      chunkDigest: await sha256Buffer(tailChunk),
    },
    state,
    handlers,
  );
  await handleProtocolMessage(
    { type: "file-end", fileId: "file-1", bytes: manifestItem.size, digest: fileDigest },
    state,
    handlers,
  );

  expect(receivedBlobs).toHaveLength(1);
  expect(receivedBlobs[0]?.size).toBe(manifestItem.size);
});

test("repeated file-start preserves one large-file sink and its processed offset", async () => {
  const manifestItem = {
    id: "file-1",
    name: "large.zip",
    size: 1024 * 1024 + MANIFEST_CHUNK_BYTES,
  };
  const stored = new Uint8Array(manifestItem.size);
  const digest = createSha256Digest();
  let factoryCalls = 0;
  let writes = 0;
  let committedBytes = 0;
  let durableBytes = 0;
  const durableProgress: number[] = [];
  const backend: LargeFileSinkBackend = {
    get committedBytes() {
      return committedBytes;
    },
    get durableBytes() {
      return durableBytes;
    },
    async write(_chunkIndex, offset, bytes) {
      stored.set(new Uint8Array(bytes), offset);
      digest.update(bytes);
      writes += 1;
      committedBytes = offset + bytes.byteLength;
      durableBytes = committedBytes;
    },
    async restore(restoredBytes) {
      committedBytes = restoredBytes;
      durableBytes = restoredBytes;
      return restoredBytes;
    },
    async finalize() {
      throw new Error("Unexpected finalize.");
    },
    reset() {},
  };
  setLargeFileSinkFactoryForTests(() => {
    factoryCalls += 1;
    return backend;
  });
  try {
    const state = buildReceiverState([manifestItem], new Map(), "session-opfs-sink");
    const firstChunk = repeatedByte(0x62, MANIFEST_CHUNK_BYTES);
    const handlers = receiverHandlersWith({
      onDurableProgress(_fileId, nextDurableBytes) {
        durableProgress.push(nextDurableBytes);
      },
    });
    await handleProtocolMessage(
      { type: "file-start", file: manifestItem, offset: 0 },
      state,
      handlers,
    );
    await handleProtocolMessage(
      {
        type: "chunk",
        fileId: manifestItem.id,
        chunkIndex: 0,
        offset: 0,
        bytes: firstChunk,
        chunkDigest: await sha256Buffer(firstChunk),
      },
      state,
      handlers,
    );
    await handleProtocolMessage(
      { type: "file-start", file: manifestItem, offset: MANIFEST_CHUNK_BYTES },
      state,
      handlers,
    );

    expect(factoryCalls).toBe(1);
    expect(writes).toBe(1);
    expect(state.currentBytes).toBe(MANIFEST_CHUNK_BYTES);
    expect(durableProgress).toEqual([MANIFEST_CHUNK_BYTES]);
  } finally {
    setLargeFileSinkFactoryForTests(null);
  }
});

test("receiver resume seeds cached leading zero-byte file before active progress", () => {
  const manifest = [
    { id: "file-1", name: "empty.txt", size: 0 },
    { id: "file-2", name: "large.zip", size: MANIFEST_CHUNK_BYTES * 4 },
  ];
  const state = buildReceiverState(
    manifest,
    new Map([
      ["file-1", 0],
      ["file-2", MANIFEST_CHUNK_BYTES * 2],
    ]),
    "default",
    new Set(["file-1"]),
  );

  expect(state.receivedFiles).toBe(1);
  expect(state.completedBytes).toBe(0);
  expect(state.currentBytes).toBe(MANIFEST_CHUNK_BYTES * 2);
  expect(state.currentChunkIndex).toBe(2);
});

test("a fully durable prefix remains resumable until file finalization", () => {
  const file = { id: "file-1", name: "large.zip", size: MANIFEST_CHUNK_BYTES };
  const state = buildReceiverState(
    [file],
    new Map([[file.id, file.size]]),
    "session-durable-not-finalized",
  );

  expect(state.receivedFiles).toBe(0);
  expect(receiverResumeProgress(state).files).toEqual([
    {
      fileId: file.id,
      size: file.size,
      chunkSize: MANIFEST_CHUNK_BYTES,
      committedBytes: file.size,
      completed: false,
    },
  ]);
});

test("receiver resume preserves a leading zero-byte file before an active large file offset", async () => {
  const manifest = [
    { id: "file-1", name: "empty.txt", size: 0 },
    { id: "file-2", name: "large.zip", size: 1024 * 1024 + MANIFEST_CHUNK_BYTES },
  ];
  const emptyFile = manifest[0];
  const largeFile = manifest[1];
  if (!emptyFile || !largeFile) throw new Error("Expected empty and large manifest items.");
  setLargeFileSinkFactoryForTests(() => ({
    committedBytes: MANIFEST_CHUNK_BYTES,
    durableBytes: MANIFEST_CHUNK_BYTES,
    async write() {},
    async restore(durableBytes) {
      return durableBytes;
    },
    async finalize() {
      throw new Error("Unexpected finalize.");
    },
    reset() {},
  }));
  try {
    const state = buildReceiverState(manifest, new Map([["file-2", MANIFEST_CHUNK_BYTES]]));
    const receivedFileIds: string[] = [];
    const handlers = receiverHandlersWith({
      onFileReceived(file) {
        receivedFileIds.push(file.id);
      },
    });

    await handleProtocolMessage(
      { type: "file-start", file: emptyFile, offset: 0 },
      state,
      handlers,
    );
    await handleProtocolMessage(
      { type: "file-end", fileId: "file-1", bytes: 0, digest: await sha256Hex("") },
      state,
      handlers,
    );
    await handleProtocolMessage(
      { type: "file-start", file: largeFile, offset: MANIFEST_CHUNK_BYTES },
      state,
      handlers,
    );

    expect(receivedFileIds).toEqual(["file-1"]);
    expect(state.currentFile?.id).toBe("file-2");
    expect(state.currentBytes).toBe(MANIFEST_CHUNK_BYTES);
  } finally {
    setLargeFileSinkFactoryForTests(null);
  }
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

  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    handlers,
  );
  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 0,
      offset: 0,
      bytes: bytesOf("alpha"),
      chunkDigest: await sha256Hex("alpha"),
    },
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

  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    handlers,
  );
  await handleProtocolMessage(
    {
      type: "chunk",
      fileId: "file-1",
      chunkIndex: 0,
      offset: 0,
      bytes: bytesOf("alpha"),
      chunkDigest: await sha256Hex("alpha"),
    },
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

test("chunk missing digest fails before commit", async () => {
  const manifestItem = { id: "file-1", name: "alpha.txt", size: 5 };
  const state = buildReceiverState([manifestItem]);
  let commitCalls = 0;

  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    receiverHandlersWith({}),
  );
  await expect(
    handleProtocolMessage(
      {
        type: "chunk",
        fileId: "file-1",
        chunkIndex: 0,
        offset: 0,
        bytes: bytesOf("alpha"),
      } as never,
      state,
      receiverHandlersWith({}),
      {
        onChunkCommit() {
          commitCalls += 1;
        },
      },
    ),
  ).rejects.toThrow("Chunk integrity verification failed.");
  expect(commitCalls).toBe(0);
});

test("chunk empty digest fails before commit", async () => {
  const manifestItem = { id: "file-1", name: "alpha.txt", size: 5 };
  const state = buildReceiverState([manifestItem]);
  let commitCalls = 0;

  await handleProtocolMessage(
    { type: "file-start", file: manifestItem, offset: 0 },
    state,
    receiverHandlersWith({}),
  );
  await expect(
    handleProtocolMessage(
      {
        type: "chunk",
        fileId: "file-1",
        chunkIndex: 0,
        offset: 0,
        bytes: bytesOf("alpha"),
        chunkDigest: "",
      },
      state,
      receiverHandlersWith({}),
      {
        onChunkCommit() {
          commitCalls += 1;
        },
      },
    ),
  ).rejects.toThrow("Chunk integrity verification failed.");
  expect(commitCalls).toBe(0);
});
test("wrong chunk file, offset, and digest fail safely before commit", async () => {
  const manifestItem = { id: "file-1", name: "alpha.txt", size: 5 };
  const cases = [
    {
      message: {
        type: "chunk" as const,
        fileId: "file-2",
        chunkIndex: 0,
        offset: 0,
        bytes: bytesOf("alpha"),
        chunkDigest: await sha256Hex("alpha"),
      },
      error: "Sender sent a chunk for the wrong file.",
    },
    {
      message: {
        type: "chunk" as const,
        fileId: "file-1",
        chunkIndex: 0,
        offset: 1,
        bytes: bytesOf("alpha"),
        chunkDigest: await sha256Hex("alpha"),
      },
      error: "Sender sent a chunk at the wrong offset.",
    },
    {
      message: {
        type: "chunk" as const,
        fileId: "file-1",
        chunkIndex: 0,
        offset: 0,
        bytes: bytesOf("alpha"),
        chunkDigest: "0".repeat(64),
      },
      error: "Chunk integrity verification failed.",
    },
  ];

  for (const item of cases) {
    const state = buildReceiverState([manifestItem]);
    let commitCalls = 0;
    let completeCalls = 0;
    const handlers = receiverHandlersWith({
      onComplete() {
        completeCalls += 1;
      },
    });

    await handleProtocolMessage(
      { type: "file-start", file: manifestItem, offset: 0 },
      state,
      handlers,
    );
    await expect(
      handleProtocolMessage(item.message, state, handlers, {
        onChunkCommit() {
          commitCalls += 1;
        },
      }),
    ).rejects.toThrow(item.error);
    await handleProtocolMessage(
      { type: "complete", totalBytes: manifestItem.size },
      state,
      handlers,
    );
    expect(commitCalls).toBe(0);
    expect(completeCalls).toBe(0);
  }
});

test("large file fails at receive start when OPFS is unavailable", async () => {
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  try {
    const manifestItem = { id: "file-1", name: "large.zip", size: 1024 * 1024 + 1 };
    const state = buildReceiverState([manifestItem]);

    await expect(
      handleProtocolMessage(
        { type: "file-start", file: manifestItem, offset: 0 },
        state,
        receiverHandlersWith({}),
      ),
    ).rejects.toThrow("Large-file receiver storage unavailable.");
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
  }
});

test("OPFS large-file partial handles are namespaced by receiver session", () => {
  const file = { id: "file-1", name: "large.zip", size: 1024 * 1024 + 1 };
  expect(opfsPartName("session-a", file)).toBe("p2pfile-session-a-file-1-1048577.part");
  expect(opfsPartName("session-b", file)).toBe("p2pfile-session-b-file-1-1048577.part");
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
        manifestHash: "wrong",
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
    handleProtocolMessage({ type: "file-start", file: nextFile, offset: 0 }, state, handlers),
  ).rejects.toThrow("Sender sent files out of order.");

  await handleProtocolMessage({ type: "complete", totalBytes: 9 }, state, handlers);
  expect(completeCalls).toBe(0);
});

test("sendSignal throws when the signal socket is not OPEN", () => {
  const closed = {
    readyState: 3,
    send() {
      throw new Error("should not send");
    },
  } as unknown as WebSocket;

  expect(() => sendSignal(closed, { type: "mode", payload: { mode: "relay" } })).toThrow(
    "Relay signaling disconnected.",
  );
});

test("trySendSignal returns false on closed sockets without throwing", () => {
  const closed = {
    readyState: 3,
    send() {
      throw new Error("should not send");
    },
  } as unknown as WebSocket;

  expect(trySendSignal(closed, { type: "mode", payload: { mode: "relay" } })).toBe(false);
});

test("trySendSignal forwards open sockets and returns true", () => {
  const sent: string[] = [];
  const open = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  } as unknown as WebSocket;

  expect(trySendSignal(open, { type: "mode", payload: { mode: "relay" } })).toBe(true);
  expect(JSON.parse(sent[0] ?? "{}")).toEqual({ type: "mode", payload: { mode: "relay" } });
});
