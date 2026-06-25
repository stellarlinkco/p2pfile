import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

type FlowId =
  | "local-session-entry-transfer"
  | "worker-share-link-edge"
  | "large-transfer-reliability"
  | "direct-active-signal-reconnect-large-transfer"
  | "network-degradation-stability"
  | "sender-abrupt-exit"
  | "storage-pressure-large-file"
  | "turn-relay-only-transfer"
  | "redis-backed-signal-e2e"
  | "browser-matrix-stability";

type FlowCommand = {
  argv: string[];
  targets: string[];
  pathPrefixes: string[];
  prerequisites?: () => void;
};

const CONFIG_PATH = ".agents/qa/config.yaml";
const STABILITY_TEST = "tests/e2e/transfer-stability.e2e.ts";
const STABILITY_PREFIXES = [
  "apps/web/src/lib/transfer/",
  "apps/web/src/routes/",
  "apps/signal/",
  "packages/shared/",
  "tests/e2e/transfer-stability",
  "playwright.config.ts",
];

const FLOW_COMMANDS: Record<FlowId, FlowCommand> = {
  "local-session-entry-transfer": {
    argv: [
      "bunx",
      "playwright",
      "test",
      "tests/e2e/p2p-file-v1.e2e.ts",
      "tests/e2e/workflow-e1.e2e.ts",
    ],
    targets: ["local-vite-signal"],
    pathPrefixes: [
      "apps/web/",
      "apps/signal/",
      "packages/shared/",
      "tests/e2e/p2p-file-v1",
      "tests/e2e/workflow-e1",
      "playwright.config.ts",
    ],
  },
  "worker-share-link-edge": {
    argv: ["bunx", "playwright", "test", "-c", "tests/e2e/worker.playwright.config.ts"],
    targets: ["local-worker-edge"],
    pathPrefixes: [
      "apps/web/",
      "apps/edge/",
      "packages/shared/",
      "tests/e2e/worker",
      "tests/e2e/p2p-file-v1.support.ts",
    ],
  },
  "large-transfer-reliability": {
    argv: ["bunx", "playwright", "test", "tests/e2e/large-transfer.e2e.ts"],
    targets: ["local-vite-signal"],
    pathPrefixes: [
      "apps/web/src/lib/transfer/",
      "apps/web/src/routes/",
      "apps/signal/",
      "packages/shared/",
      "tests/e2e/large-transfer",
      "playwright.config.ts",
    ],
  },
  "direct-active-signal-reconnect-large-transfer": {
    argv: [
      "bunx",
      "playwright",
      "test",
      STABILITY_TEST,
      "-g",
      "active Direct Transfer survives sender signaling reconnect",
    ],
    targets: ["local-vite-signal"],
    pathPrefixes: STABILITY_PREFIXES,
  },
  "network-degradation-stability": {
    argv: [
      "bunx",
      "playwright",
      "test",
      STABILITY_TEST,
      "-g",
      "network-degraded Direct Transfer and Relayed Transfer",
    ],
    targets: ["local-vite-signal"],
    pathPrefixes: STABILITY_PREFIXES,
  },
  "sender-abrupt-exit": {
    argv: [
      "bunx",
      "playwright",
      "test",
      STABILITY_TEST,
      "-g",
      "sender page close during active transfer|sender reload during active transfer",
    ],
    targets: ["local-vite-signal"],
    pathPrefixes: STABILITY_PREFIXES,
  },
  "storage-pressure-large-file": {
    argv: [
      "bunx",
      "playwright",
      "test",
      STABILITY_TEST,
      "-g",
      "OPFS unavailable for a large file|OPFS write failure for a large file",
    ],
    targets: ["local-vite-signal"],
    pathPrefixes: STABILITY_PREFIXES,
  },
  "turn-relay-only-transfer": {
    argv: ["bunx", "playwright", "test", "tests/e2e/turn-relay-only-transfer.e2e.ts"],
    targets: ["local-vite-signal"],
    pathPrefixes: [
      "apps/web/src/lib/transfer/",
      "apps/web/vite.config.ts",
      "tests/e2e/turn-relay-only-transfer.e2e.ts",
      "tests/e2e/transfer-stability.support.ts",
    ],
    prerequisites: assertTurnPrerequisites,
  },
  "redis-backed-signal-e2e": {
    argv: ["bunx", "playwright", "test", "tests/e2e/redis-backed-signal.e2e.ts"],
    targets: ["local-redis-signal"],
    pathPrefixes: [
      "apps/signal/src/",
      "tests/e2e/redis-backed-signal.e2e.ts",
      "tests/e2e/transfer-stability.support.ts",
    ],
    prerequisites: assertRedisPrerequisites,
  },
  "browser-matrix-stability": {
    argv: [
      "bunx",
      "playwright",
      "test",
      STABILITY_TEST,
      "-g",
      "browser capability baseline keeps environment-dependent transfer disclosure",
    ],
    targets: ["local-vite-signal"],
    pathPrefixes: STABILITY_PREFIXES,
  },
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function envValue(name: string): string {
  const value = Bun.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function assertTurnPrerequisites(): void {
  const missing = ["VITE_TURN_URL", "VITE_TURN_USERNAME", "VITE_TURN_CREDENTIAL"].filter(
    (name) => !envValue(name),
  );
  if (missing.length > 0) {
    fail(
      `turn-relay-only-transfer is blocked until local TURN sandbox variables are configured. Missing: ${missing.join(", ")}.`,
    );
  }
}

function assertRedisPrerequisites(): void {
  if (!envValue("REDIS_URL")) {
    fail(
      "redis-backed-signal-e2e is blocked until REDIS_URL points at a reachable Redis-backed signal setup.",
    );
  }
}

async function parseConfig() {
  const raw = await Bun.file(CONFIG_PATH).text();
  const parsed = Bun.YAML.parse(raw);
  const config = asRecord(parsed);
  if (!config) fail(`${CONFIG_PATH} must contain a YAML object.`);
  return config;
}

function flowRecords(config: Record<string, unknown>) {
  const flows = config.flows;
  if (!Array.isArray(flows) || flows.length === 0) fail("QA config must define at least one flow.");
  return flows.map((flow) => {
    const record = asRecord(flow);
    if (!record) fail("Each QA flow must be an object.");
    const id = stringValue(record.id);
    const note = stringValue(record.note);
    if (!id || !note) fail("Each QA flow must include id and note.");
    return { id, note, record };
  });
}

function assertNoPlaceholdersInArgv(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (typeof item !== "string") fail(`${path}[${index}] must be a string argv item.`);
      if (/[{}]/.test(item)) fail(`${path}[${index}] must not embed dynamic placeholders in argv.`);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, nextValue] of Object.entries(record)) {
    assertNoPlaceholdersInArgv(nextValue, `${path}.${key}`);
  }
}

async function validateFlowNote(
  id: string,
  notePath: string,
  record: Record<string, unknown>,
): Promise<void> {
  if (!existsSync(notePath)) fail(`Missing flow note: ${notePath}`);
  const note = await readFile(notePath, "utf8");
  if (!note.startsWith(`# Flow: ${id}`)) fail(`${notePath} must start with # Flow: ${id}.`);
  for (const section of [
    "## Scope",
    "## Driver contract for future runs",
    "## Future run steps",
    "## Evidence expected",
    "## Known blockers",
  ]) {
    if (!note.includes(section)) fail(`${notePath} is missing ${section}.`);
  }
  const tests = record.owned_tests;
  if (!Array.isArray(tests)) fail(`${id} must list owned_tests.`);
  for (const testPath of tests) {
    if (typeof testPath !== "string") fail(`${id} owned_tests entries must be strings.`);
    if (!existsSync(testPath)) fail(`${id} references missing test file: ${testPath}`);
  }
}

async function checkInstall(): Promise<void> {
  const config = await parseConfig();
  if (stringValue(config.project) !== "P2P File") fail("QA config project must be P2P File.");
  const commands = asRecord(config.commands);
  if (!commands) fail("QA config must define commands.");
  assertNoPlaceholdersInArgv(commands, "commands");
  for (const flow of flowRecords(config)) {
    await validateFlowNote(flow.id, flow.note, flow.record);
    if (!(flow.id in FLOW_COMMANDS)) fail(`No local command mapping for flow: ${flow.id}`);
  }
  const forbiddenRunFiles = [
    ".agents/qa/RUN_DIR",
    ".agents/qa/verdict.json",
    ".agents/qa/REPORT.md",
  ];
  for (const path of forbiddenRunFiles) {
    if (existsSync(path)) fail(`Run output does not belong in install directory: ${path}`);
  }
  console.log("QA E2E install check passed.");
}

function flowIdFromEnv(): FlowId {
  const id = envValue("QA_E2E_FLOW_ID");
  if (id in FLOW_COMMANDS) return id as FlowId;
  fail(`Unknown QA_E2E_FLOW_ID: ${id || "<empty>"}`);
}

function runArgv(argv: string[]): void {
  const [command, ...args] = argv;
  if (!command) fail("Missing command.");
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function runFlow(): Promise<void> {
  await checkInstall();
  const id = flowIdFromEnv();
  const target = envValue("QA_E2E_TARGET");
  const command = FLOW_COMMANDS[id];
  if (target && !command.targets.includes(target)) {
    fail(
      `${id} does not support QA_E2E_TARGET=${target}. Supported: ${command.targets.join(", ")}.`,
    );
  }
  command.prerequisites?.();
  runArgv(command.argv);
}

function changedFiles(baseSha: string, headSha: string): string[] {
  const result = spawnSync("git", ["diff", "--name-only", baseSha, headSha], { encoding: "utf8" });
  if (result.status !== 0) fail("Unable to compute changed files for PR QA selection.");
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function selectedFlows(files: string[]): FlowId[] {
  const selected: FlowId[] = [];
  for (const [id, command] of Object.entries(FLOW_COMMANDS) as Array<[FlowId, FlowCommand]>) {
    if (
      files.some((file) =>
        command.pathPrefixes.some((prefix) => file.startsWith(prefix) || file === prefix),
      )
    ) {
      selected.push(id);
    }
  }
  return selected.length > 0 ? selected : (Object.keys(FLOW_COMMANDS) as FlowId[]);
}

async function runPr(): Promise<void> {
  await checkInstall();
  const baseSha = envValue("QA_E2E_BASE_SHA");
  const headSha = envValue("QA_E2E_HEAD_SHA");
  if (!baseSha || !headSha)
    fail("QA_E2E_BASE_SHA and QA_E2E_HEAD_SHA are required for PR E2E selection.");
  const files = changedFiles(baseSha, headSha);
  const qaMapChanged = files.some((file) => file.startsWith(".agents/qa/"));
  if (qaMapChanged && envValue("QA_E2E_TRUST_QA_MAP") !== "1") {
    fail(
      "QA map or flow notes changed. Compare with trusted base map, then rerun with QA_E2E_TRUST_QA_MAP=1 if approved.",
    );
  }
  let executedFlows = 0;
  for (const id of selectedFlows(files)) {
    console.log(`Running QA flow: ${id}`);
    const command = FLOW_COMMANDS[id];
    if (command.prerequisites) {
      console.log(`Skipping blocked QA flow: ${id}`);
      continue;
    }
    runArgv(command.argv);
    executedFlows += 1;
  }
  if (executedFlows === 0) {
    fail("No runnable QA flows were selected for this PR diff.");
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function validateRunDir(): Promise<void> {
  await checkInstall();
  const runDir = envValue("QA_E2E_RUN_DIR");
  if (!runDir) fail("QA_E2E_RUN_DIR is required.");
  if (runDir === ".agents/qa" || runDir.startsWith(".agents/qa/")) {
    fail("Run evidence must not be stored in .agents/qa.");
  }
  if (!existsSync(runDir) || !statSync(runDir).isDirectory())
    fail(`Run directory does not exist: ${runDir}`);
  const files = await listFiles(runDir);
  console.log(
    `QA run directory is structurally readable: ${relative(process.cwd(), runDir)} (${files.length} files).`,
  );
}

const subcommand = process.argv[2] ?? "check";
if (subcommand === "check") await checkInstall();
else if (subcommand === "run") await runFlow();
else if (subcommand === "pr") await runPr();
else if (subcommand === "validate") await validateRunDir();
else fail(`Unknown qa-e2e subcommand: ${subcommand}`);
