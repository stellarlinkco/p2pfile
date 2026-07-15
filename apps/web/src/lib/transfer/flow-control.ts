import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";

export type TransferFlowMode = "direct" | "relay";
export type TransferFlowControl = {
  currentMaxInFlightBytes: () => number;
};

type TransferFlowControllerOptions = {
  initialChunks?: number;
};

const FLOW_PROFILES = {
  direct: { initialChunks: 16, minChunks: 8, maxChunks: 64 },
  relay: { initialChunks: 8, minChunks: 4, maxChunks: 16 },
} as const;

export class TransferFlowController {
  readonly hardMaxBytes: number;
  readonly hardMinBytes: number;
  private readonly currentBytes: number;

  constructor(mode: TransferFlowMode, options: TransferFlowControllerOptions = {}) {
    const profile = FLOW_PROFILES[mode];
    this.hardMinBytes = profile.minChunks * MANIFEST_CHUNK_BYTES;
    this.hardMaxBytes = profile.maxChunks * MANIFEST_CHUNK_BYTES;
    const requestedChunks = Math.floor(options.initialChunks ?? profile.initialChunks);
    this.currentBytes = Math.max(
      this.hardMinBytes,
      Math.min(requestedChunks * MANIFEST_CHUNK_BYTES, this.hardMaxBytes),
    );
  }

  currentMaxInFlightBytes() {
    return this.currentBytes;
  }
}
