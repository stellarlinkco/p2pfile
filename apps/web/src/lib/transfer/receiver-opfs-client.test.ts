import { expect, test } from "bun:test";
import { isInvalidOpfsCheckpointError, OpfsWorkerClient } from "./receiver-opfs-client";
import type { OpfsWorkerCommand, OpfsWorkerResponse } from "./receiver-opfs-worker-protocol";

class FakeWorker extends EventTarget {
  readonly commands: OpfsWorkerCommand[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  constructor(private readonly respond: (command: OpfsWorkerCommand) => OpfsWorkerResponse) {
    super();
  }

  postMessage(command: OpfsWorkerCommand, transfer: Transferable[] = []) {
    this.commands.push(command);
    this.transfers.push(transfer);
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent("message", { data: this.respond(command) }));
    });
  }

  terminate() {
    this.terminated = true;
  }
}

const file = { id: "file-1", name: "large.bin", size: 4 };

function progressResponse(
  command: OpfsWorkerCommand,
  type: "opened" | "restored" | "written" | "flushed",
  processedBytes: number,
  durableBytes: number,
): OpfsWorkerResponse {
  return {
    type,
    requestId: command.requestId,
    generation: command.generation,
    fileId: file.id,
    processedBytes,
    durableBytes,
  };
}

test("OPFS worker client serializes writes and finalizes the worker-owned file", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
  const durableProgress: number[] = [];
  const worker = new FakeWorker((command) => {
    if (command.type === "open") return progressResponse(command, "opened", 0, 0);
    if (command.type === "write") {
      return progressResponse(command, "written", command.offset + command.bytes.byteLength, 0);
    }
    if (command.type === "finalize") {
      return {
        type: "finalized",
        requestId: command.requestId,
        generation: command.generation,
        fileId: file.id,
        bytes: file.size,
        durableBytes: file.size,
        digest: "digest",
        blob,
      };
    }
    throw new Error(`Unexpected ${command.type} command.`);
  });
  const client = new OpfsWorkerClient(
    "session-1",
    file,
    worker as unknown as Worker,
    (durableBytes) => durableProgress.push(durableBytes),
  );
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;

  await client.write(0, 0, bytes);
  expect(client.committedBytes).toBe(4);
  expect(client.durableBytes).toBe(0);
  expect(worker.transfers[1]).toEqual([bytes]);

  const finalized = await client.finalize();
  expect(finalized.digest).toBe("digest");
  expect(finalized.file.blob).toBe(blob);
  expect(worker.commands.map((command) => command.type)).toEqual(["open", "write", "finalize"]);
  expect(worker.terminated).toBeTrue();
  expect(durableProgress).toEqual([4]);
  URL.revokeObjectURL(finalized.file.url);
});

test("OPFS worker client preserves a classified open failure for later operations", async () => {
  const worker = new FakeWorker((command) => ({
    type: "error",
    requestId: command.requestId,
    generation: command.generation,
    fileId: file.id,
    code: "quota",
    message: "disk full",
  }));
  const client = new OpfsWorkerClient("session-1", file, worker as unknown as Worker);

  await expect(client.restore(0)).rejects.toThrow(
    "Large-file storage quota was exceeded. disk full",
  );
  const quotaError = await client.restore(0).catch((error: unknown) => error);
  expect(isInvalidOpfsCheckpointError(quotaError)).toBeFalse();
  await expect(client.write(0, 0, new ArrayBuffer(1))).rejects.toThrow(
    "Large-file storage quota was exceeded. disk full",
  );
  expect(worker.terminated).toBeTrue();
});

test("OPFS worker client identifies invalid durable checkpoint failures", async () => {
  const worker = new FakeWorker((command) => ({
    type: "error",
    requestId: command.requestId,
    generation: command.generation,
    fileId: file.id,
    code: "invalid",
    message: "durable prefix is invalid",
  }));
  const client = new OpfsWorkerClient("session-1", file, worker as unknown as Worker);

  const error = await client.restore(1).catch((failure: unknown) => failure);

  expect(isInvalidOpfsCheckpointError(error)).toBeTrue();
});

test("OPFS worker client surfaces an asynchronous checkpoint failure", async () => {
  const failures: string[] = [];
  const worker = new FakeWorker((command) => {
    if (command.type === "open") return progressResponse(command, "opened", 0, 0);
    if (command.type === "write") {
      return progressResponse(command, "written", command.offset + command.bytes.byteLength, 0);
    }
    return {
      type: "error",
      requestId: command.requestId,
      generation: command.generation,
      fileId: file.id,
      code: "quota",
      message: "checkpoint failed",
    };
  });
  const client = new OpfsWorkerClient(
    "session-1",
    file,
    worker as unknown as Worker,
    undefined,
    (error) => failures.push(error.message),
  );

  await client.write(0, 0, new Uint8Array([1]).buffer);
  await Bun.sleep(1_100);

  expect(failures).toEqual(["Large-file storage quota was exceeded. checkpoint failed"]);
  expect(worker.terminated).toBeTrue();
});
