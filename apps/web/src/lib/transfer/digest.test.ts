import { expect, test } from "bun:test";
import { computeDigestHex, createSha256Digest } from "./digest";

function makeBytes(size: number) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 17 + size) % 251;
  }
  return bytes;
}

async function webCryptoSha256Hex(bytes: Uint8Array) {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("incremental sha-256 matches Web Crypto across block boundaries", async () => {
  for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 1024, 64 * 1024 + 3]) {
    const bytes = makeBytes(size);
    const digest = createSha256Digest();
    for (let offset = 0; offset < bytes.byteLength; offset += 37) {
      digest.update(bytes.subarray(offset, offset + 37));
    }

    expect(digest.digestHex()).toBe(await webCryptoSha256Hex(bytes));
  }
});

test("computeDigestHex does not require a combined input buffer", async () => {
  const first = makeBytes(64 * 1024 - 1).buffer as ArrayBuffer;
  const second = makeBytes(64 * 1024 + 5).buffer as ArrayBuffer;
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(new Uint8Array(first), 0);
  combined.set(new Uint8Array(second), first.byteLength);

  expect(await computeDigestHex([first, second])).toBe(await webCryptoSha256Hex(combined));
});
