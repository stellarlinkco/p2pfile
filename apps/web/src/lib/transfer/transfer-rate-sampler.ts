const WINDOW_MS = 3_000;
const MIN_SAMPLE_SPAN_MS = 500;
const PUBLISH_INTERVAL_MS = 250;
const STALL_MS = 2_000;
const RECORD_INTERVAL_MS = 100;
const SAMPLE_CAPACITY = 40;

export class TransferRateSampler {
  private readonly byteSamples = new Float64Array(SAMPLE_CAPACITY);
  private readonly timeSamples = new Float64Array(SAMPLE_CAPACITY);
  private count = 0;
  private head = 0;
  private lastProgressAt = 0;
  private lastPublishedAt = 0;

  sample(usefulCommittedBytes: number, now = performance.now()): number | undefined {
    const latestIndex = this.latestIndex();
    const latestBytes = latestIndex === null ? 0 : (this.byteSamples[latestIndex] ?? 0);
    if (latestIndex !== null && usefulCommittedBytes < latestBytes) {
      this.reset();
    }

    if (this.count === 0) {
      this.push(usefulCommittedBytes, now);
      this.lastProgressAt = now;
      this.lastPublishedAt = now;
      return undefined;
    }

    const currentLatestIndex = this.latestIndex();
    if (currentLatestIndex === null) return undefined;
    if (usefulCommittedBytes > (this.byteSamples[currentLatestIndex] ?? 0)) {
      this.lastProgressAt = now;
    }

    const shouldPublish = now - this.lastPublishedAt >= PUBLISH_INTERVAL_MS;
    if (
      now - (this.timeSamples[currentLatestIndex] ?? now) >= RECORD_INTERVAL_MS ||
      shouldPublish
    ) {
      this.push(usefulCommittedBytes, now);
    }
    this.prune(now - WINDOW_MS);

    if (!shouldPublish) return undefined;
    this.lastPublishedAt = now;
    if (now - this.lastProgressAt >= STALL_MS) return 0;

    const oldestIndex = this.head;
    const newestIndex = this.latestIndex();
    if (newestIndex === null) return undefined;
    const elapsedMs =
      (this.timeSamples[newestIndex] ?? now) - (this.timeSamples[oldestIndex] ?? now);
    if (elapsedMs < MIN_SAMPLE_SPAN_MS) return undefined;
    const usefulBytes = (this.byteSamples[newestIndex] ?? 0) - (this.byteSamples[oldestIndex] ?? 0);
    return Math.max(0, (usefulBytes * 1_000) / elapsedMs);
  }

  reset() {
    this.count = 0;
    this.head = 0;
    this.lastProgressAt = 0;
    this.lastPublishedAt = 0;
  }

  private latestIndex() {
    if (this.count === 0) return null;
    return (this.head + this.count - 1) % SAMPLE_CAPACITY;
  }

  private push(bytes: number, at: number) {
    if (this.count === SAMPLE_CAPACITY) {
      this.head = (this.head + 1) % SAMPLE_CAPACITY;
      this.count -= 1;
    }
    const index = (this.head + this.count) % SAMPLE_CAPACITY;
    this.byteSamples[index] = bytes;
    this.timeSamples[index] = at;
    this.count += 1;
  }

  private prune(cutoff: number) {
    while (this.count > 1 && (this.timeSamples[this.head] ?? cutoff) < cutoff) {
      this.head = (this.head + 1) % SAMPLE_CAPACITY;
      this.count -= 1;
    }
  }
}
