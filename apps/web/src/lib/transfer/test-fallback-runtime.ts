import { applyMode, buildReceiverState, handleProtocolMessage } from "./runtime-shared";
import type {
  ReceivedFile,
  ReceiverRuntime,
  ReceiverRuntimeHandlers,
  SenderRuntime,
  SenderRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function manifestFromFiles(files: File[]) {
  return files.map((file, index) => ({
    id: `file-${index + 1}`,
    name: file.name,
    size: file.size,
  }));
}

function createChannelName(sessionId: string) {
  return `p2pfile:test:${sessionId}`;
}

async function sendTransfer(
  channel: BroadcastChannel,
  files: File[],
  handlers: SenderRuntimeHandlers,
) {
  const manifest = manifestFromFiles(files);
  const totalBytes = manifest.reduce((sum, file) => sum + file.size, 0);
  handlers.onMode("relay");
  handlers.onStatus("Relayed Transfer connected");
  channel.postMessage({
    type: "manifest",
    files: manifest,
    totalBytes,
  } satisfies TransferProtocolMessage);
  await sleep(0);

  let completedBytes = 0;
  let completedFiles = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const manifestItem = manifest[index];
    if (!file || !manifestItem) {
      continue;
    }

    channel.postMessage({
      type: "file-start",
      file: manifestItem,
    } satisfies TransferProtocolMessage);
    let fileBytes = 0;
    for (let offset = 0; offset < file.size; offset += 64 * 1024) {
      const bytes = await file.slice(offset, offset + 64 * 1024).arrayBuffer();
      channel.postMessage({
        type: "chunk",
        fileId: manifestItem.id,
        bytes,
      } satisfies TransferProtocolMessage);
      fileBytes += bytes.byteLength;
      handlers.onProgress({
        fileId: manifestItem.id,
        fileName: manifestItem.name,
        fileBytes,
        fileTotalBytes: manifestItem.size,
        completedBytes: completedBytes + fileBytes,
        totalBytes,
        completedFiles,
        totalFiles: files.length,
      });
      await sleep(0);
    }

    channel.postMessage({
      type: "file-end",
      fileId: manifestItem.id,
      bytes: fileBytes,
    } satisfies TransferProtocolMessage);
    completedBytes += fileBytes;
    completedFiles += 1;
    await sleep(0);
  }

  channel.postMessage({ type: "complete", totalBytes } satisfies TransferProtocolMessage);
}

export async function startSenderTestFallbackRuntime(
  sessionId: string,
  _senderToken: string,
  files: File[],
  handlers: SenderRuntimeHandlers,
): Promise<SenderRuntime> {
  const channel = new BroadcastChannel(createChannelName(sessionId));
  let stopped = false;
  let completed = false;
  let started = false;

  const close = () => {
    if (completed) {
      return;
    }
    channel.postMessage({ type: "sender-left", payload: {} });
    channel.close();
  };

  channel.onmessage = (event) => {
    const message = event.data as TransferProtocolMessage | { type: string; payload?: unknown };
    if (stopped || completed) {
      return;
    }

    if (message.type === "receiver-ready" && !started) {
      started = true;
      void sendTransfer(channel, files, handlers).then(() => {
        completed = true;
        handlers.onComplete();
        channel.close();
      });
      return;
    }

    if (message.type === "mode" && typeof message.payload === "object" && message.payload) {
      applyMode((message.payload as { mode: "direct" | "relay" }).mode, handlers);
    }
  };

  return {
    stop() {
      stopped = true;
      close();
    },
    markSenderLeft() {
      close();
    },
  };
}

export async function startReceiverTestFallbackRuntime(
  sessionId: string,
  _receiverToken: string,
  expectedManifest: ReceivedFile[] | { id: string; name: string; size: number }[],
  handlers: ReceiverRuntimeHandlers,
  receivedFiles: ReceivedFile[] = [],
): Promise<ReceiverRuntime> {
  const channel = new BroadcastChannel(createChannelName(sessionId));
  const expected = expectedManifest.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
  }));
  const state = buildReceiverState(expected);
  let stopped = false;
  let completed = false;

  if (receivedFiles.length > 0) {
    for (const file of receivedFiles) {
      handlers.onFileReceived(file);
    }
  }

  handlers.onMode("relay");
  handlers.onStatus("Relayed Transfer connected");
  channel.postMessage({
    type: "receiver-ready",
    payload: { completedFiles: receivedFiles.length },
  });

  channel.onmessage = (event) => {
    if (stopped || completed) {
      return;
    }

    const message = event.data as TransferProtocolMessage | { type: string; payload?: unknown };
    if (message.type === "sender-left") {
      handlers.onEnded();
      return;
    }

    if (message.type === "mode") {
      handlers.onMode((message.payload as { mode: "direct" | "relay" }).mode);
      return;
    }

    try {
      if (
        message.type === "manifest" ||
        message.type === "file-start" ||
        message.type === "chunk" ||
        message.type === "file-end" ||
        message.type === "complete"
      ) {
        handleProtocolMessage(message as TransferProtocolMessage, state, handlers);
        if (message.type === "file-end") {
          channel.postMessage({
            type: "receiver-ready",
            payload: { completedFiles: state.receivedFiles },
          });
        }
        if (message.type === "complete") {
          completed = true;
          handlers.onComplete();
          channel.close();
        }
      }
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : "接收文件失败。");
    }
  };

  return {
    stop() {
      stopped = true;
      channel.close();
    },
    release() {
      stopped = true;
      channel.close();
    },
  };
}
