import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { OpfsFileCore } from "./receiver-opfs-core";

type FakeSyncHandleOptions = {
  existing?: Uint8Array;
  shortWriteAt?: number;
};

class FakeSyncHandle {
  readonly flushOffsets: number[] = [];
  readonly readLengths: number[] = [];
  readonly writeOffsets: number[] = [];
  closed = false;
  private bytes: Uint8Array;
  private readonly shortWriteAt: number | undefined;

  constructor(options: FakeSyncHandleOptions = {}) {
    this.bytes = options.existing?.slice() ?? new Uint8Array();
    this.shortWriteAt = options.shortWriteAt;
  }

  write(buffer: ArrayBufferView, options?: { at?: number }) {
    const offset = options?.at ?? 0;
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const written = offset === this.shortWriteAt ? source.byteLength - 1 : source.byteLength;
    const required = offset + written;
    if (required > this.bytes.byteLength) {
      const grown = new Uint8Array(required);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(source.subarray(0, written), offset);
    this.writeOffsets.push(offset);
    return written;
  }

  read(buffer: ArrayBufferView, options?: { at?: number }) {
    const offset = options?.at ?? 0;
    const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const available = Math.max(0, Math.min(target.byteLength, this.bytes.byteLength - offset));
    target.set(this.bytes.subarray(offset, offset + available));
    this.readLengths.push(target.byteLength);
    return available;
  }

  flush() {
    this.flushOffsets.push(this.bytes.byteLength);
  }

  getSize() {
    return this.bytes.byteLength;
  }

  truncate(newSize: number) {
    this.bytes = this.bytes.slice(0, newSize);
  }

  close() {
    this.closed = true;
  }

  snapshot() {
    return this.bytes.slice();
  }
}

function chunk(seed: number) {
  const bytes = new Uint8Array(MANIFEST_CHUNK_BYTES);
  bytes.fill(seed);
  return bytes.buffer;
}

test("OPFS core checkpoints one MiB without reopening or copying existing bytes", () => {
  const handle = new FakeSyncHandle();
  const core = new OpfsFileCore(handle, {
    id: "file-1",
    name: "large.bin",
    size: 2 * 1024 * 1024,
  });

  for (let index = 0; index < 32; index += 1) {
    core.write(index, index * MANIFEST_CHUNK_BYTES, chunk(index));
  }

  expect(handle.writeOffsets).toHaveLength(32);
  expect(handle.flushOffsets).toEqual([1024 * 1024, 2 * 1024 * 1024]);
  expect(core.processedBytes).toBe(2 * 1024 * 1024);
  expect(core.durableBytes).toBe(2 * 1024 * 1024);
  core.close();
  expect(handle.closed).toBe(true);
});

test("OPFS core restores digest through bounded reads before appending", () => {
  const existing = new Uint8Array(MANIFEST_CHUNK_BYTES * 3);
  existing.fill(0x5a);
  const handle = new FakeSyncHandle({ existing });
  const core = new OpfsFileCore(handle, {
    id: "file-1",
    name: "large.bin",
    size: MANIFEST_CHUNK_BYTES * 4,
  });

  core.restore(existing.byteLength);
  core.write(3, existing.byteLength, chunk(4));
  const result = core.finalize();

  expect(Math.max(...handle.readLengths)).toBe(MANIFEST_CHUNK_BYTES);
  expect(handle.readLengths).toHaveLength(3);
  expect(result.bytes).toBe(MANIFEST_CHUNK_BYTES * 4);
  expect(result.digest).toHaveLength(64);
});

test("OPFS core discards a stale part when resume restarts from zero", () => {
  const handle = new FakeSyncHandle({ existing: new Uint8Array(MANIFEST_CHUNK_BYTES) });
  const core = new OpfsFileCore(handle, {
    id: "file-1",
    name: "large.bin",
    size: MANIFEST_CHUNK_BYTES,
  });

  core.restore(0);

  expect(handle.snapshot()).toHaveLength(0);
});

test("OPFS core truncates a stale suffix beyond a positive checkpoint", () => {
  const handle = new FakeSyncHandle({
    existing: new Uint8Array(MANIFEST_CHUNK_BYTES * 2),
  });
  const core = new OpfsFileCore(handle, {
    id: "file-1",
    name: "large.bin",
    size: MANIFEST_CHUNK_BYTES * 2,
  });

  core.restore(MANIFEST_CHUNK_BYTES);

  expect(handle.snapshot()).toHaveLength(MANIFEST_CHUNK_BYTES);
});

test("OPFS core rejects a short write without advancing progress", () => {
  const handle = new FakeSyncHandle({ shortWriteAt: 0 });
  const core = new OpfsFileCore(handle, {
    id: "file-1",
    name: "large.bin",
    size: 2 * MANIFEST_CHUNK_BYTES,
  });

  expect(() => core.write(0, 0, chunk(1))).toThrow("OPFS wrote an incomplete chunk.");
  expect(core.processedBytes).toBe(0);
  expect(core.durableBytes).toBe(0);
});
