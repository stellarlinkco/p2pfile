const DEFAULT_INITIAL_RTO_MS = 1_000;
const DEFAULT_MIN_RTO_MS = 500;
const DEFAULT_MAX_RTO_MS = 4_000;
const TIMER_GRANULARITY_MS = 50;
const SRTT_ALPHA = 1 / 8;
const RTTVAR_BETA = 1 / 4;

export class RelayRtoEstimator {
  private readonly initialRtoMs: number;
  private readonly maxRtoMs: number;
  private readonly minRtoMs: number;
  private smoothedRttMs: number | null = null;
  private rttVariationMs = 0;
  currentMs: number;

  constructor(options: { initialMs?: number; minMs?: number; maxMs?: number } = {}) {
    this.minRtoMs = Math.max(1, options.minMs ?? DEFAULT_MIN_RTO_MS);
    this.maxRtoMs = Math.max(this.minRtoMs, options.maxMs ?? DEFAULT_MAX_RTO_MS);
    this.initialRtoMs = this.clamp(options.initialMs ?? DEFAULT_INITIAL_RTO_MS);
    this.currentMs = this.initialRtoMs;
  }

  record(sampleMs: number) {
    if (!Number.isFinite(sampleMs) || sampleMs <= 0) return;
    if (this.smoothedRttMs === null) {
      this.smoothedRttMs = sampleMs;
      this.rttVariationMs = sampleMs / 2;
    } else {
      this.rttVariationMs =
        (1 - RTTVAR_BETA) * this.rttVariationMs +
        RTTVAR_BETA * Math.abs(this.smoothedRttMs - sampleMs);
      this.smoothedRttMs = (1 - SRTT_ALPHA) * this.smoothedRttMs + SRTT_ALPHA * sampleMs;
    }
    this.currentMs = this.clamp(
      this.smoothedRttMs + Math.max(TIMER_GRANULARITY_MS, 4 * this.rttVariationMs),
    );
  }

  reset() {
    this.smoothedRttMs = null;
    this.rttVariationMs = 0;
    this.currentMs = this.initialRtoMs;
  }

  private clamp(value: number) {
    return Math.round(Math.max(this.minRtoMs, Math.min(value, this.maxRtoMs)));
  }
}
