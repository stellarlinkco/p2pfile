import { expect, test } from "bun:test";
import { type FileManifestItem, MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { createSha256Digest } from "./digest";
import { buildReceiverState, handleProtocolMessage } from "./receiver-protocol";
import { startReceiverRuntime } from "./receiver-runtime";
import { FakePeerConnection, FakeWebSocket } from "./receiver-runtime-fixtures";
import { encodeBinaryRelayChunkFrame } from "./relay-runtime";
import type { ReceiverRuntimeHandlers } from "./types";

function receiverHandlers(): ReceiverRuntimeHandlers {
  return {
    onComplete() {},
    onEnded() {},
    onError() {},
    onFileReceived() {},
    onMode() {},
    onProgress() {},
    onStatus() {},
  };
}

async function withReceiverHarness(run: () => Promise<void>) {
  const previousPeerConnection = globalThis.RTCPeerConnection;
  const previousWebSocket = globalThis.WebSocket;
  const previousCrypto = globalThis.crypto;
  const deterministicCrypto = Object.create(previousCrypto) as Crypto;
  Object.defineProperty(deterministicCrypto, "randomUUID", {
    value: () => "receiver-instance-test",
  });
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  Object.defineProperty(globalThis, "crypto", {
    value: deterministicCrypto,
    configurable: true,
  });
  try {
    await run();
  } finally {
    globalThis.RTCPeerConnection = previousPeerConnection;
    globalThis.WebSocket = previousWebSocket;
    Object.defineProperty(globalThis, "crypto", {
      value: previousCrypto,
      configurable: true,
    });
  }
}

test("receiver-ready reports committed offset for active single large file", async () => {
  await withReceiverHarness(async () => {
    const file: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 4,
      mimeType: "application/zip",
    };
    const runtime = await startReceiverRuntime(
      "session-active",
      "receiver-token",
      [file],
      receiverHandlers(),
      [],
      new Map([[file.id, MANIFEST_CHUNK_BYTES * 2]]),
    );

    try {
      const socket = FakeWebSocket.instances[0];
      expect(socket?.sent[0]).toEqual({
        type: "receiver-ready",
        payload: {
          completedFiles: 0,
          receiverInstanceId: "receiver-instance-test",
          progress: {
            manifestHash: `${file.id}:${file.name}:${file.size}`,
            files: [
              {
                fileId: file.id,
                size: file.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: MANIFEST_CHUNK_BYTES * 2,
                completed: false,
              },
            ],
          },
        },
      });
    } finally {
      runtime.stop();
    }
  });
});

test("receiver restore reports active committed progress before reconnect", async () => {
  await withReceiverHarness(async () => {
    const file: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 4,
      mimeType: "application/zip",
    };
    const progress: Array<Parameters<ReceiverRuntimeHandlers["onProgress"]>[0]> = [];
    const runtime = await startReceiverRuntime(
      "session-active-restore",
      "receiver-token",
      [file],
      {
        ...receiverHandlers(),
        onProgress(nextProgress) {
          progress.push(nextProgress);
        },
      },
      [],
      new Map([[file.id, MANIFEST_CHUNK_BYTES * 2]]),
    );

    try {
      expect(progress.at(-1)).toMatchObject({
        fileId: file.id,
        fileBytes: MANIFEST_CHUNK_BYTES * 2,
        completedBytes: MANIFEST_CHUNK_BYTES * 2,
        files: [
          {
            fileId: file.id,
            fileBytes: MANIFEST_CHUNK_BYTES * 2,
            state: "reconnecting",
          },
        ],
      });
    } finally {
      runtime.stop();
    }
  });
});
test("receiver forwards relay chunk-commit only after relay chunk is verified and written", async () => {
  await withReceiverHarness(async () => {
    const file: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 2,
      mimeType: "application/zip",
    };
    const runtime = await startReceiverRuntime(
      "session-relay",
      "receiver-token",
      [file],
      receiverHandlers(),
    );
    const bytes = new Uint8Array(MANIFEST_CHUNK_BYTES);
    bytes.fill(12);
    const digest = createSha256Digest();
    digest.update(bytes.buffer);
    const chunkDigest = digest.digestHex();
    const relayManifest = {
      type: "relay-message" as const,
      payload: {
        sequence: 0,
        message: {
          type: "manifest" as const,
          files: [file],
          totalBytes: file.size,
          manifestHash: `${file.id}:${file.name}:${file.size}`,
        },
      },
    };

    try {
      const socket = FakeWebSocket.instances[0];
      if (!socket) throw new Error("expected receiver socket");
      const relayCommits = () => socket.sent.filter((message) => message.type === "relay-message");
      socket.dispatchMessage({ type: "mode", payload: { mode: "relay" } });
      socket.dispatchMessage(relayManifest);
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 1,
          message: { type: "file-start", file, offset: 0 },
        },
      });
      socket.dispatchBlob(
        encodeBinaryRelayChunkFrame(2, {
          type: "chunk",
          fileId: file.id,
          chunkIndex: 0,
          offset: 0,
          bytes: bytes.buffer,
          chunkDigest,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      const relayAcks = socket.sent.filter((message) => message.type === "relay-ack");
      expect(relayAcks.map((message) => message.payload.sequence)).toEqual([0, 1, 2]);
      expect(socket.sent.find((message) => message.type === "relay-message")).toEqual({
        type: "relay-message",
        payload: {
          sequence: 0,
          message: {
            type: "chunk-commit",
            fileId: file.id,
            chunkIndex: 0,
            committedBytes: MANIFEST_CHUNK_BYTES,
          },
        },
      });
      await Bun.sleep(1_100);
      expect(relayCommits().length).toBeGreaterThan(1);
      socket.dispatchMessage({ type: "relay-ack", payload: { sequence: 0 } });
      const commitsAfterAck = relayCommits().length;
      await Bun.sleep(1_100);
      expect(relayCommits()).toHaveLength(commitsAfterAck);
      socket.dispatchMessage(relayManifest);
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 1,
          message: { type: "file-start", file, offset: MANIFEST_CHUNK_BYTES },
        },
      });
      socket.dispatchBlob(
        encodeBinaryRelayChunkFrame(2, {
          type: "chunk",
          fileId: file.id,
          chunkIndex: 1,
          offset: MANIFEST_CHUNK_BYTES,
          bytes: bytes.buffer,
          chunkDigest,
        }),
      );
      await Bun.sleep(50);
      expect(
        relayCommits().some(
          (message) =>
            message.payload.message.type === "chunk-commit" &&
            message.payload.message.chunkIndex === 1,
        ),
      ).toBeTrue();
      const commitsBeforeClose = relayCommits().length;
      socket.close();
      await Bun.sleep(300);
      expect(relayCommits()).toHaveLength(commitsBeforeClose);
    } finally {
      runtime.stop();
    }
  });
});

test("receiver sends relay chunk-commit over WebSocket when a direct channel is still open", async () => {
  await withReceiverHarness(async () => {
    const file: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES,
      mimeType: "application/zip",
    };
    const runtime = await startReceiverRuntime(
      "session-relay-open-direct",
      "receiver-token",
      [file],
      receiverHandlers(),
    );
    const bytes = new Uint8Array(MANIFEST_CHUNK_BYTES);
    bytes.fill(14);
    const digest = createSha256Digest();
    digest.update(bytes.buffer);
    const directChannelSent: string[] = [];
    const directChannel = {
      binaryType: "arraybuffer",
      addEventListener(type: string, listener: () => void) {
        if (type === "open") listener();
      },
      removeEventListener() {},
      send(data: string) {
        directChannelSent.push(data);
      },
    } as unknown as RTCDataChannel;

    try {
      const socket = FakeWebSocket.instances[0];
      const peer = FakePeerConnection.instances[0];
      if (!socket || !peer) throw new Error("expected receiver runtime fakes");
      peer.dispatchDataChannel(directChannel);
      socket.dispatchMessage({ type: "mode", payload: { mode: "relay" } });
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 0,
          message: {
            type: "manifest",
            files: [file],
            totalBytes: file.size,
            manifestHash: `${file.id}:${file.name}:${file.size}`,
          },
        },
      });
      socket.dispatchMessage({
        type: "relay-message",
        payload: { sequence: 1, message: { type: "file-start", file, offset: 0 } },
      });
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 2,
          message: {
            type: "chunk",
            fileId: file.id,
            chunkIndex: 0,
            offset: 0,
            bytesBase64: btoa(String.fromCharCode(...bytes)),
            chunkDigest: digest.digestHex(),
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(directChannelSent).toEqual([]);
      expect(socket.sent.find((message) => message.type === "relay-message")).toEqual({
        type: "relay-message",
        payload: {
          sequence: 0,
          message: {
            type: "chunk-commit",
            fileId: file.id,
            chunkIndex: 0,
            committedBytes: MANIFEST_CHUNK_BYTES,
          },
        },
      });
    } finally {
      runtime.stop();
    }
  });
});

test("receiver accepts a restarted relay epoch when sender sequence resets to manifest zero", async () => {
  await withReceiverHarness(async () => {
    const file: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 2,
      mimeType: "application/zip",
    };
    const receivedFiles: string[] = [];
    const runtime = await startReceiverRuntime("session-relay-restart", "receiver-token", [file], {
      ...receiverHandlers(),
      onFileReceived(file) {
        receivedFiles.push(file.id);
      },
    });
    const firstChunk = new Uint8Array(MANIFEST_CHUNK_BYTES);
    firstChunk.fill(12);
    const secondChunk = new Uint8Array(MANIFEST_CHUNK_BYTES);
    secondChunk.fill(13);
    const firstDigest = createSha256Digest();
    firstDigest.update(firstChunk.buffer);
    const secondDigest = createSha256Digest();
    secondDigest.update(secondChunk.buffer);
    const fileDigest = createSha256Digest();
    fileDigest.update(firstChunk.buffer);
    fileDigest.update(secondChunk.buffer);
    const manifest = {
      type: "manifest" as const,
      files: [file],
      totalBytes: file.size,
      manifestHash: `${file.id}:${file.name}:${file.size}`,
    };

    try {
      const socket = FakeWebSocket.instances[0];
      if (!socket) throw new Error("expected receiver socket");
      socket.dispatchMessage({ type: "mode", payload: { mode: "relay" } });
      socket.dispatchMessage({
        type: "relay-message",
        payload: { sequence: 0, message: manifest },
      });
      socket.dispatchMessage({
        type: "relay-message",
        payload: { sequence: 1, message: { type: "file-start", file, offset: 0 } },
      });
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 2,
          message: {
            type: "chunk",
            fileId: file.id,
            chunkIndex: 0,
            offset: 0,
            bytesBase64: btoa(String.fromCharCode(...firstChunk)),
            chunkDigest: firstDigest.digestHex(),
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      socket.dispatchMessage({
        type: "relay-message",
        payload: { sequence: 0, message: manifest },
      });
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 1,
          message: { type: "file-start", file, offset: MANIFEST_CHUNK_BYTES },
        },
      });
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 2,
          message: {
            type: "chunk",
            fileId: file.id,
            chunkIndex: 1,
            offset: MANIFEST_CHUNK_BYTES,
            bytesBase64: btoa(String.fromCharCode(...secondChunk)),
            chunkDigest: secondDigest.digestHex(),
          },
        },
      });
      socket.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 3,
          message: {
            type: "file-end",
            fileId: file.id,
            bytes: file.size,
            digest: fileDigest.digestHex(),
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(receivedFiles).toEqual([file.id]);
    } finally {
      runtime.stop();
    }
  });
});

test("receiver-ready reports completed files and active committed offset together", async () => {
  await withReceiverHarness(async () => {
    const completedFile: FileManifestItem = {
      id: "done-1",
      name: "done.txt",
      size: 128,
      mimeType: "text/plain",
    };
    const activeFile: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 4,
      mimeType: "application/zip",
    };
    const runtime = await startReceiverRuntime(
      "session-mixed",
      "receiver-token",
      [completedFile, activeFile],
      receiverHandlers(),
      [
        {
          id: completedFile.id,
          name: completedFile.name,
          size: completedFile.size,
          blob: new Blob(["done"], { type: completedFile.mimeType }),
          url: "blob:done-1",
        },
      ],
      new Map([[activeFile.id, MANIFEST_CHUNK_BYTES * 2]]),
    );

    try {
      const socket = FakeWebSocket.instances[0];
      expect(socket?.sent[0]).toEqual({
        type: "receiver-ready",
        payload: {
          completedFiles: 1,
          receiverInstanceId: "receiver-instance-test",
          progress: {
            manifestHash: `${completedFile.id}:${completedFile.name}:${completedFile.size}|${activeFile.id}:${activeFile.name}:${activeFile.size}`,
            files: [
              {
                fileId: completedFile.id,
                size: completedFile.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: completedFile.size,
                completed: true,
              },
              {
                fileId: activeFile.id,
                size: activeFile.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: MANIFEST_CHUNK_BYTES * 2,
                completed: false,
              },
            ],
          },
        },
      });
    } finally {
      runtime.stop();
    }
  });
});

test("receiver-ready reports completed active and queued manifest entries", async () => {
  await withReceiverHarness(async () => {
    const completedFile: FileManifestItem = {
      id: "done-1",
      name: "done.txt",
      size: 128,
      mimeType: "text/plain",
    };
    const activeFile: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 4,
      mimeType: "application/zip",
    };
    const queuedFile: FileManifestItem = {
      id: "queued-1",
      name: "queued.bin",
      size: MANIFEST_CHUNK_BYTES,
      mimeType: "application/octet-stream",
    };
    const runtime = await startReceiverRuntime(
      "session-full-vector",
      "receiver-token",
      [completedFile, activeFile, queuedFile],
      receiverHandlers(),
      [
        {
          id: completedFile.id,
          name: completedFile.name,
          size: completedFile.size,
          blob: new Blob(["done"], { type: completedFile.mimeType }),
          url: "blob:done-1",
        },
      ],
      new Map([[activeFile.id, MANIFEST_CHUNK_BYTES * 2]]),
    );

    try {
      const socket = FakeWebSocket.instances[0];
      expect(socket?.sent[0]).toEqual({
        type: "receiver-ready",
        payload: {
          completedFiles: 1,
          receiverInstanceId: "receiver-instance-test",
          progress: {
            manifestHash: `${completedFile.id}:${completedFile.name}:${completedFile.size}|${activeFile.id}:${activeFile.name}:${activeFile.size}|${queuedFile.id}:${queuedFile.name}:${queuedFile.size}`,
            files: [
              {
                fileId: completedFile.id,
                size: completedFile.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: completedFile.size,
                completed: true,
              },
              {
                fileId: activeFile.id,
                size: activeFile.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: MANIFEST_CHUNK_BYTES * 2,
                completed: false,
              },
              {
                fileId: queuedFile.id,
                size: queuedFile.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: 0,
                completed: false,
              },
            ],
          },
        },
      });
    } finally {
      runtime.stop();
    }
  });
});

test("receiver-ready does not report uncached leading zero-byte file as completed", async () => {
  await withReceiverHarness(async () => {
    const emptyFile: FileManifestItem = {
      id: "empty-uncached",
      name: "empty.txt",
      size: 0,
      mimeType: "text/plain",
    };
    const activeFile: FileManifestItem = {
      id: "large-after-empty",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 4,
      mimeType: "application/zip",
    };
    const progressEvents: Array<{ fileId: string | null; completedFiles: number }> = [];
    const runtime = await startReceiverRuntime(
      "session-empty-uncached",
      "receiver-token",
      [emptyFile, activeFile],
      {
        ...receiverHandlers(),
        onProgress(progress) {
          progressEvents.push({
            fileId: progress.fileId,
            completedFiles: progress.completedFiles,
          });
        },
      },
      [],
      new Map([[activeFile.id, MANIFEST_CHUNK_BYTES * 2]]),
    );

    try {
      const socket = FakeWebSocket.instances[0];
      expect(progressEvents).toEqual([{ fileId: activeFile.id, completedFiles: 0 }]);
      expect(socket?.sent[0]).toEqual({
        type: "receiver-ready",
        payload: {
          completedFiles: 0,
          receiverInstanceId: "receiver-instance-test",
          progress: {
            manifestHash: `${emptyFile.id}:${emptyFile.name}:${emptyFile.size}|${activeFile.id}:${activeFile.name}:${activeFile.size}`,
            files: [
              {
                fileId: emptyFile.id,
                size: 0,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: 0,
                completed: false,
              },
              {
                fileId: activeFile.id,
                size: activeFile.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: MANIFEST_CHUNK_BYTES * 2,
                completed: false,
              },
            ],
          },
        },
      });
    } finally {
      runtime.stop();
    }
  });
});

test("receiver protocol completes uncached zero-byte file only after file-end", async () => {
  const emptyFile: FileManifestItem = {
    id: "empty-protocol",
    name: "empty.txt",
    size: 0,
    mimeType: "text/plain",
  };
  const activeFile: FileManifestItem = {
    id: "large-after-empty",
    name: "large.zip",
    size: MANIFEST_CHUNK_BYTES * 4,
    mimeType: "application/zip",
  };
  const progressEvents: Array<{ fileId: string | null; completedFiles: number }> = [];
  const receivedFiles: string[] = [];
  const state = buildReceiverState(
    [emptyFile, activeFile],
    new Map([[activeFile.id, MANIFEST_CHUNK_BYTES * 2]]),
  );

  expect(state.receivedFiles).toBe(0);
  expect(state.currentBytes).toBe(0);

  await handleProtocolMessage({ type: "file-start", file: emptyFile, offset: 0 }, state, {
    ...receiverHandlers(),
    onFileReceived(file) {
      receivedFiles.push(file.id);
    },
    onProgress(progress) {
      progressEvents.push({
        fileId: progress.fileId,
        completedFiles: progress.completedFiles,
      });
    },
  });

  expect(state.receivedFiles).toBe(0);

  await handleProtocolMessage(
    {
      type: "file-end",
      fileId: emptyFile.id,
      bytes: 0,
      digest: createSha256Digest().digestHex(),
    },
    state,
    {
      ...receiverHandlers(),
      onFileReceived(file) {
        receivedFiles.push(file.id);
      },
      onProgress(progress) {
        progressEvents.push({
          fileId: progress.fileId,
          completedFiles: progress.completedFiles,
        });
      },
    },
  );

  expect(state.receivedFiles).toBe(1);
  expect(state.currentBytes).toBe(MANIFEST_CHUNK_BYTES * 2);
  expect(receivedFiles).toEqual([emptyFile.id]);
  expect(progressEvents).toEqual([{ fileId: emptyFile.id, completedFiles: 1 }]);
});
test("receiver-ready reports cached leading zero-byte file before active committed offset", async () => {
  await withReceiverHarness(async () => {
    const emptyFile: FileManifestItem = {
      id: "empty-1",
      name: "empty.txt",
      size: 0,
      mimeType: "text/plain",
    };
    const activeFile: FileManifestItem = {
      id: "large-1",
      name: "large.zip",
      size: MANIFEST_CHUNK_BYTES * 4,
      mimeType: "application/zip",
    };
    const progressEvents: Array<{ fileId: string | null; completedFiles: number }> = [];
    const runtime = await startReceiverRuntime(
      "session-empty-active",
      "receiver-token",
      [emptyFile, activeFile],
      {
        ...receiverHandlers(),
        onProgress(progress) {
          progressEvents.push({
            fileId: progress.fileId,
            completedFiles: progress.completedFiles,
          });
        },
      },
      [
        {
          id: emptyFile.id,
          name: emptyFile.name,
          size: emptyFile.size,
          blob: new Blob([], { type: emptyFile.mimeType }),
          url: "blob:empty-1",
        },
      ],
      new Map([[activeFile.id, MANIFEST_CHUNK_BYTES * 2]]),
    );

    try {
      const socket = FakeWebSocket.instances[0];
      expect(progressEvents).toEqual([{ fileId: activeFile.id, completedFiles: 1 }]);
      expect(socket?.sent[0]).toEqual({
        type: "receiver-ready",
        payload: {
          completedFiles: 1,
          receiverInstanceId: "receiver-instance-test",
          progress: {
            manifestHash: `${emptyFile.id}:${emptyFile.name}:${emptyFile.size}|${activeFile.id}:${activeFile.name}:${activeFile.size}`,
            files: [
              {
                fileId: emptyFile.id,
                size: 0,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: 0,
                completed: true,
              },
              {
                fileId: activeFile.id,
                size: activeFile.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: MANIFEST_CHUNK_BYTES * 2,
                completed: false,
              },
            ],
          },
        },
      });
    } finally {
      runtime.stop();
    }
  });
});

test("receiver accepts a nonzero relay generation manifest", async () => {
  await withReceiverHarness(async () => {
    const file: FileManifestItem = {
      id: "file-1",
      name: "alpha.txt",
      size: 1,
      mimeType: "text/plain",
    };
    const statuses: string[] = [];
    const runtime = await startReceiverRuntime(
      "session-nonzero-relay-generation",
      "receiver-token",
      [file],
      {
        ...receiverHandlers(),
        onStatus(status) {
          statuses.push(status);
        },
      },
    );

    try {
      const socket = FakeWebSocket.instances[0];
      socket?.dispatchMessage({
        type: "relay-message",
        payload: {
          sequence: 41,
          message: {
            type: "manifest",
            files: [file],
            totalBytes: file.size,
            manifestHash: `${file.id}:${file.name}:${file.size}`,
          },
        },
      });
      socket?.dispatchMessage({
        type: "relay-message",
        payload: { sequence: 42, message: { type: "file-start", file, offset: 0 } },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(statuses).toContain("Receiving alpha.txt");
    } finally {
      runtime.stop();
    }
  });
});

test("stopped receiver runtime reports not alive after stop and after relay socket close", async () => {
  await withReceiverHarness(async () => {
    const file: FileManifestItem = {
      id: "file-1",
      name: "alpha.txt",
      size: 1,
      mimeType: "text/plain",
    };

    const stoppedByStop = await startReceiverRuntime(
      "session-alive-stop",
      "receiver-token",
      [file],
      receiverHandlers(),
    );
    expect(stoppedByStop.isAlive()).toBe(true);
    expect(stoppedByStop.isEstablished()).toBe(false);
    stoppedByStop.stop();
    expect(stoppedByStop.isAlive()).toBe(false);
    expect(stoppedByStop.isEstablished()).toBe(false);

    const replacementStatuses: string[] = [];
    const stoppedByReplacement = await startReceiverRuntime(
      "session-alive-replaced",
      "receiver-token",
      [file],
      {
        ...receiverHandlers(),
        onStatus(status) {
          replacementStatuses.push(status);
        },
      },
    );
    const replacementSocket = FakeWebSocket.instances.at(-1);
    replacementSocket?.close("replaced");
    expect(stoppedByReplacement.isAlive()).toBe(false);
    expect(stoppedByReplacement.isEstablished()).toBe(false);
    expect(replacementStatuses).toContain("Receiver connection replaced");

    const stoppedByRelayClose = await startReceiverRuntime(
      "session-alive-relay-close",
      "receiver-token",
      [file],
      receiverHandlers(),
    );
    expect(stoppedByRelayClose.isAlive()).toBe(true);
    const socket = FakeWebSocket.instances.at(-1);
    socket?.dispatchMessage({ type: "mode", payload: { mode: "relay" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stoppedByRelayClose.isEstablished()).toBe(true);
    socket?.close();
    expect(stoppedByRelayClose.isAlive()).toBe(false);
    expect(stoppedByRelayClose.isEstablished()).toBe(false);
  });
});
