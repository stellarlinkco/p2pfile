import {
  TransferFlowController,
  type TransferFlowMode,
} from "../apps/web/src/lib/transfer/flow-control";
import {
  buildTransferPlan,
  initialResumeProgress,
} from "../apps/web/src/lib/transfer/sender-runtime-helpers";
import { sendScheduledTransfer } from "../apps/web/src/lib/transfer/transfer-scheduler";
import type { SenderRuntimeHandlers } from "../apps/web/src/lib/transfer/types";
import { MANIFEST_CHUNK_BYTES } from "../packages/shared/src";

const PROFILE_BYTES = 32 * 1024 * 1024;

const handlers: SenderRuntimeHandlers = {
  onStatus() {},
  onMode() {},
  onProgress() {},
  onComplete() {},
  onError(message) {
    throw new Error(message);
  },
};

type Scenario = {
  name: string;
  rttMs: number;
  delayEvery: number | null;
  directBufferChunks: number;
  relayBufferChunks: number;
};

type Result = {
  mode: TransferFlowMode;
  scenario: string;
  windowChunks: number;
  usefulBytesPerSecond: number;
  commitRttP95Ms: number;
  peakInFlightBytes: number;
  peakBufferedBytes: number;
  injectedDelayEvents: number;
};

const scenarios: Scenario[] = [
  { name: "local", rttMs: 5, delayEvery: null, directBufferChunks: 32, relayBufferChunks: 8 },
  { name: "high-rtt", rttMs: 200, delayEvery: null, directBufferChunks: 32, relayBufferChunks: 8 },
  {
    name: "constrained-buffer",
    rttMs: 80,
    delayEvery: null,
    directBufferChunks: 8,
    relayBufferChunks: 4,
  },
  {
    name: "periodic-commit-delay",
    rttMs: 100,
    delayEvery: 7,
    directBufferChunks: 16,
    relayBufferChunks: 8,
  },
];

function percentile95(samples: number[]) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

async function runProfile(
  mode: TransferFlowMode,
  scenario: Scenario,
  windowChunks: number,
): Promise<Result> {
  // A fixed 32 MiB payload gives even the largest window sixteen steady-state
  // turns, preventing startup and single-RTT effects from deciding the profile.
  const bytes = new Uint8Array(PROFILE_BYTES).fill(0x5a);
  const file = new File([bytes], `${mode}-${scenario.name}.bin`);
  const plan = buildTransferPlan([file]);
  const active = new Set<Promise<number>>();
  const commitRtts: number[] = [];
  const bufferCapChunks =
    mode === "direct" ? scenario.directBufferChunks : scenario.relayBufferChunks;
  let peakBufferedBytes = 0;
  let sendCount = 0;
  let injectedDelayEvents = 0;
  let telemetry: Record<string, unknown> | undefined;

  await sendScheduledTransfer([file], {
    handlers,
    mode,
    plan,
    progress: initialResumeProgress(plan),
    recordEvent(event) {
      telemetry = event;
    },
    scheduler: {
      maxActiveFiles: 1,
      flowControl: new TransferFlowController(mode, { initialChunks: windowChunks }),
    },
    shouldContinue: () => true,
    transport: {
      async beforeChunk() {
        while (active.size >= bufferCapChunks) await Promise.race(active);
      },
      bufferedBytes: () => active.size * MANIFEST_CHUNK_BYTES,
      complete() {},
      endFile() {},
      sendManifest() {},
      startFile() {},
      sendChunk(chunk) {
        const startedAt = performance.now();
        sendCount += 1;
        const delayed = scenario.delayEvery !== null && sendCount % scenario.delayEvery === 0;
        if (delayed) injectedDelayEvents += 1;
        const extraDelay = delayed ? Math.max(500, scenario.rttMs * 2) : 0;
        const promise = new Promise<number>((resolve) => {
          setTimeout(() => {
            commitRtts.push(performance.now() - startedAt);
            resolve(chunk.offset + chunk.bytes.byteLength);
          }, scenario.rttMs + extraDelay);
        });
        active.add(promise);
        peakBufferedBytes = Math.max(peakBufferedBytes, active.size * MANIFEST_CHUNK_BYTES);
        void promise.finally(() => active.delete(promise));
        return promise;
      },
    },
  });

  return {
    mode,
    scenario: scenario.name,
    windowChunks,
    usefulBytesPerSecond: Number(telemetry?.usefulBytesPerSecond ?? 0),
    commitRttP95Ms: percentile95(commitRtts),
    peakInFlightBytes: Number(telemetry?.peakInFlightBytes ?? 0),
    peakBufferedBytes,
    injectedDelayEvents,
  };
}

const profiles = { direct: [8, 16, 32], relay: [4, 8, 16] } as const;
const staticProfile = { direct: 16, relay: 8 } as const;
const results: Result[] = [];
for (const mode of ["direct", "relay"] as const) {
  for (const scenario of scenarios) {
    for (const windowChunks of profiles[mode]) {
      results.push(await runProfile(mode, scenario, windowChunks));
    }
  }
}

const failures: string[] = [];
for (const result of results) {
  if (result.usefulBytesPerSecond <= 0)
    failures.push(`${result.mode}/${result.scenario}: no progress`);
  if (result.peakInFlightBytes > result.windowChunks * MANIFEST_CHUNK_BYTES) {
    failures.push(`${result.mode}/${result.scenario}: in-flight bound exceeded`);
  }
  const scenario = scenarios.find((candidate) => candidate.name === result.scenario);
  const cap = result.mode === "direct" ? scenario?.directBufferChunks : scenario?.relayBufferChunks;
  if (cap !== undefined && result.peakBufferedBytes > cap * MANIFEST_CHUNK_BYTES) {
    failures.push(`${result.mode}/${result.scenario}: transport buffer bound exceeded`);
  }
}
for (const mode of ["direct", "relay"] as const) {
  const delayedProfile = results.find(
    (result) =>
      result.mode === mode &&
      result.scenario === "periodic-commit-delay" &&
      result.windowChunks === staticProfile[mode],
  );
  if (!delayedProfile || delayedProfile.injectedDelayEvents === 0)
    failures.push(`${mode}: periodic commit-delay injection unexercised`);
}

const report = {
  schemaVersion: 1,
  verdict: failures.length > 0 ? "fail" : "inconclusive",
  evidenceClass: "deterministic in-process scheduler and commit-delay simulation",
  productionDecisionAuthorized: false,
  selectedProductionProfile: { strategy: "static", ...staticProfile },
  decisionReason:
    "Keep bounded static defaults. Adaptive default requires privileged dummynet/pf shaping or an equivalent CI network namespace plus repeated real Direct and Relay runs.",
  requiredProductionEvidence:
    "Run this matrix through real browser DataChannel and deployed Relay paths under controlled RTT, loss, and buffer shaping; this host needs administrator permission for `dnctl`/pf.",
  scenarios,
  results,
  failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length > 0 ? 1 : 2);
