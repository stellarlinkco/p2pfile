/// <reference lib="webworker" />

import type { FileManifestItem } from "@p2pfile/shared";
import { OpfsFileCore, type OpfsSyncAccessHandle } from "./receiver-opfs-core";
import {
  classifyOpfsWorkerFailure,
  enqueueExclusiveCommand,
  type OpfsWorkerCommand,
  type OpfsWorkerResponse,
  opfsPartName,
} from "./receiver-opfs-worker-protocol";

type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle: () => Promise<OpfsSyncAccessHandle>;
};

const scope = self as DedicatedWorkerGlobalScope;
const failWritesForTests =
  import.meta.env.DEV &&
  new URL(scope.location.href).searchParams.get("__p2pfile_fail_opfs_writes") === "1";
let active:
  | {
      generation: number;
      file: FileManifestItem;
      fileHandle: FileSystemFileHandle;
      core: OpfsFileCore;
    }
  | undefined;
/**
 * Chromium FileSystemSyncAccessHandle is exclusive: only one op may touch the
 * handle at a time. The previous fire-and-forget message handler allowed a
 * timer flush to race a write and surface:
 * "state cached in an interface object was made but the state had changed..."
 */
let commandChain: Promise<void> = Promise.resolve();

function post(response: OpfsWorkerResponse) {
  scope.postMessage(response);
}

function requireActive(command: OpfsWorkerCommand) {
  if (
    !active ||
    active.generation !== command.generation ||
    ("fileId" in command && command.fileId !== active.file.id)
  ) {
    throw new Error("OPFS worker command targets an inactive generation or file.");
  }
  return active;
}

async function open(command: Extract<OpfsWorkerCommand, { type: "open" }>) {
  active?.core.close();
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(opfsPartName(command.sessionId, command.file), {
    create: true,
  });
  const createSyncAccessHandle = (fileHandle as SyncFileHandle).createSyncAccessHandle;
  if (typeof createSyncAccessHandle !== "function") {
    throw new DOMException("Large-file OPFS sync access is unavailable.", "NotSupportedError");
  }
  const syncHandle = await createSyncAccessHandle.call(fileHandle);
  const core = new OpfsFileCore(syncHandle, command.file);
  active = { generation: command.generation, file: command.file, fileHandle, core };
  post({
    type: "opened",
    requestId: command.requestId,
    generation: command.generation,
    fileId: command.file.id,
    processedBytes: 0,
    durableBytes: 0,
  });
}

async function handle(command: OpfsWorkerCommand) {
  if (command.type === "open") {
    await open(command);
    return;
  }

  if (command.type === "reset") {
    if (active && active.generation === command.generation) {
      active.core.close();
      active = undefined;
    }
    post({
      type: "reset",
      requestId: command.requestId,
      generation: command.generation,
      fileId: command.fileId ?? null,
    });
    return;
  }

  const current = requireActive(command);
  if (command.type === "restore") {
    current.core.restore(command.durableBytes);
    post({
      type: "restored",
      requestId: command.requestId,
      generation: command.generation,
      fileId: current.file.id,
      processedBytes: current.core.processedBytes,
      durableBytes: current.core.durableBytes,
    });
    return;
  }

  if (command.type === "write") {
    if (failWritesForTests) throw new Error("OPFS write quota exceeded");
    const progress = current.core.write(command.chunkIndex, command.offset, command.bytes);
    post({
      type: "written",
      requestId: command.requestId,
      generation: command.generation,
      fileId: current.file.id,
      ...progress,
    });
    return;
  }

  if (command.type === "flush") {
    current.core.flush();
    post({
      type: "flushed",
      requestId: command.requestId,
      generation: command.generation,
      fileId: current.file.id,
      processedBytes: current.core.processedBytes,
      durableBytes: current.core.durableBytes,
    });
    return;
  }

  const result = current.core.finalize();
  const blob = await current.fileHandle.getFile();
  post({
    type: "finalized",
    requestId: command.requestId,
    generation: command.generation,
    fileId: current.file.id,
    ...result,
    blob,
  });
  active = undefined;
}

scope.addEventListener("message", (event: MessageEvent<OpfsWorkerCommand>) => {
  const command = event.data;
  // Serialize every command so SyncAccessHandle ops never overlap, even when
  // the main thread posts a timer flush while a write response is in flight.
  commandChain = enqueueExclusiveCommand(
    commandChain,
    () => handle(command),
    (error) => {
      active?.core.close();
      active = undefined;
      post({
        type: "error",
        requestId: command.requestId,
        generation: command.generation,
        fileId:
          command.type === "open"
            ? command.file.id
            : "fileId" in command
              ? (command.fileId ?? null)
              : null,
        code: classifyOpfsWorkerFailure(error),
        message: error instanceof Error ? error.message : "Large-file storage failed.",
      });
    },
  );
});
