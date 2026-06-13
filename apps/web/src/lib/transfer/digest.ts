const INITIAL_STATE = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const ROUND_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function toHexWord(value: number) {
  return value.toString(16).padStart(8, "0");
}

export class Sha256Digest {
  private readonly state = Uint32Array.from(INITIAL_STATE);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private byteLength = 0;
  private finalized = false;

  update(part: ArrayBuffer | Uint8Array) {
    if (this.finalized) {
      throw new Error("Digest already finalized.");
    }

    const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
    this.byteLength += bytes.byteLength;
    let offset = 0;

    if (this.blockLength > 0) {
      const needed = 64 - this.blockLength;
      const copied = Math.min(needed, bytes.byteLength);
      this.block.set(bytes.subarray(0, copied), this.blockLength);
      this.blockLength += copied;
      offset = copied;
      if (this.blockLength === 64) {
        this.processBlock(this.block);
        this.blockLength = 0;
      }
    }

    while (offset + 64 <= bytes.byteLength) {
      this.processBlock(bytes.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < bytes.byteLength) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLength = bytes.byteLength - offset;
    }

    return this;
  }

  digestHex() {
    if (this.finalized) {
      throw new Error("Digest already finalized.");
    }
    this.finalized = true;

    const finalBlock = new Uint8Array(64);
    finalBlock.set(this.block.subarray(0, this.blockLength));
    finalBlock[this.blockLength] = 0x80;

    if (this.blockLength >= 56) {
      this.processBlock(finalBlock);
      finalBlock.fill(0);
    }

    const bitLengthHigh = Math.floor(this.byteLength / 0x20000000);
    const bitLengthLow = (this.byteLength * 8) >>> 0;
    finalBlock[56] = bitLengthHigh >>> 24;
    finalBlock[57] = bitLengthHigh >>> 16;
    finalBlock[58] = bitLengthHigh >>> 8;
    finalBlock[59] = bitLengthHigh;
    finalBlock[60] = bitLengthLow >>> 24;
    finalBlock[61] = bitLengthLow >>> 16;
    finalBlock[62] = bitLengthLow >>> 8;
    finalBlock[63] = bitLengthLow;
    this.processBlock(finalBlock);

    return Array.from(this.state, toHexWord).join("");
  }

  private processBlock(block: Uint8Array) {
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      this.words[index] =
        ((block[offset] ?? 0) << 24) |
        ((block[offset + 1] ?? 0) << 16) |
        ((block[offset + 2] ?? 0) << 8) |
        (block[offset + 3] ?? 0);
    }

    for (let index = 16; index < 64; index += 1) {
      const word15 = this.words[index - 15] ?? 0;
      const word2 = this.words[index - 2] ?? 0;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      this.words[index] =
        ((this.words[index - 16] ?? 0) + sigma0 + (this.words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = this.state[0] ?? 0;
    let b = this.state[1] ?? 0;
    let c = this.state[2] ?? 0;
    let d = this.state[3] ?? 0;
    let e = this.state[4] ?? 0;
    let f = this.state[5] ?? 0;
    let g = this.state[6] ?? 0;
    let h = this.state[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 =
        (h + sum1 + choice + (ROUND_CONSTANTS[index] ?? 0) + (this.words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = ((this.state[0] ?? 0) + a) >>> 0;
    this.state[1] = ((this.state[1] ?? 0) + b) >>> 0;
    this.state[2] = ((this.state[2] ?? 0) + c) >>> 0;
    this.state[3] = ((this.state[3] ?? 0) + d) >>> 0;
    this.state[4] = ((this.state[4] ?? 0) + e) >>> 0;
    this.state[5] = ((this.state[5] ?? 0) + f) >>> 0;
    this.state[6] = ((this.state[6] ?? 0) + g) >>> 0;
    this.state[7] = ((this.state[7] ?? 0) + h) >>> 0;
  }
}

export function createSha256Digest() {
  return new Sha256Digest();
}

export async function computeDigestHex(parts: ArrayBuffer[]): Promise<string> {
  const digest = createSha256Digest();
  for (const part of parts) {
    digest.update(part);
  }
  return digest.digestHex();
}
