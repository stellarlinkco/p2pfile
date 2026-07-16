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
    if (command.type === "flush") {
      return progressResponse(command, "flushed", file.size, file.size);
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
  // finalize drains unflushed bytes before the terminal finalize command.
  expect(worker.commands.map((command) => command.type)).toEqual([
    "open",
    "write",
    "flush",
    "finalize",
  ]);
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

test("OPFS worker client surfaces Chromium cached-state failures as locked storage errors", async () => {
  const worker = new FakeWorker((command) => ({
    type: "error",
    requestId: command.requestId,
    generation: command.generation,
    fileId: file.id,
    code: "locked",
    message:
      "An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.",
  }));
  const client = new OpfsWorkerClient("session-1", file, worker as unknown as Worker);

  await expect(client.write(0, 0, new Uint8Array([1]).buffer)).rejects.toThrow(
    /Large-file storage is locked by another transfer/,
  );
  await expect(client.write(0, 0, new Uint8Array([1]).buffer)).rejects.toThrow(
    /state cached in an interface object/,
  );
  expect(worker.terminated).toBeTrue();
});

test("OPFS worker client never posts a timer flush while a write is still in flight", async () => {
  // Models the production race: checkpoint timer fires while write is awaiting
  // worker response. Without main-thread serialization, both messages hit the
  // worker concurrently and Chromium throws the cached-state InvalidStateError.
  const writeGate = Promise.withResolvers<void>();
  const inFlight: string[] = [];
  const peakInFlight: number[] = [];
  const worker = new FakeWorker(() => {
    throw new Error("unused");
  });
  worker.postMessage = (command: OpfsWorkerCommand) => {
    worker.commands.push(command);
    const respond = (response: OpfsWorkerResponse) => {
      worker.dispatchEvent(new MessageEvent("message", { data: response }));
    };
    if (command.type === "open") {
      respond(progressResponse(command, "opened", 0, 0));
      return;
    }
    if (command.type === "write") {
      inFlight.push("write");
      peakInFlight.push(inFlight.length);
      void writeGate.promise.then(() => {
        const index = inFlight.indexOf("write");
        if (index >= 0) inFlight.splice(index, 1);
        respond(progressResponse(command, "written", command.offset + command.bytes.byteLength, 0));
      });
      return;
    }
    if (command.type === "flush") {
      inFlight.push("flush");
      peakInFlight.push(inFlight.length);
      queueMicrotask(() => {
        const index = inFlight.indexOf("flush");
        if (index >= 0) inFlight.splice(index, 1);
        respond(progressResponse(command, "flushed", 1, 1));
      });
      return;
    }
    throw new Error(`Unexpected ${command.type}`);
  };

  const client = new OpfsWorkerClient("session-1", file, worker as unknown as Worker);
  const writePromise = client.write(0, 0, new Uint8Array([1]).buffer);
  await Bun.sleep(50);
  // Write still gated; timer cannot start until write returns, so no flush yet.
  expect(worker.commands.map((command) => command.type)).toEqual(["open", "write"]);
  expect(Math.max(0, ...peakInFlight)).toBe(1);
  writeGate.resolve();
  await writePromise;
  // Timer is armed only after write completes; wait past the 1s checkpoint interval.
  await Bun.sleep(1_100);
  expect(worker.commands.map((command) => command.type)).toEqual(["open", "write", "flush"]);
  // Never more than one handle op in flight from the client side.
  expect(Math.max(...peakInFlight)).toBe(1);
  client.reset();
});
