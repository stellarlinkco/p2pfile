import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const edgePackage = JSON.parse(readFileSync("apps/edge/package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const wrangler = readFileSync("wrangler.toml", "utf8");
const readme = readFileSync("README.md", "utf8");
const justfile = readFileSync("justfile", "utf8");
const workerSmoke = [
  "tests/e2e/worker-share-link.e2e.ts",
  "tests/e2e/worker-share-link.metadata.cases.ts",
  "tests/e2e/worker-share-link.lifecycle.cases.ts",
  "tests/e2e/worker-share-link.transfer.cases.ts",
  "tests/e2e/worker-share-link.retry.cases.ts",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const forbiddenCloudflareRouteTerms = [
  "apps/signal",
  "REDIS_URL",
  "Bun.RedisClient",
  "ServerWebSocket",
  "docker",
  "nginx",
];

describe("Cloudflare Worker cutover config", () => {
  test("wrangler declares static assets, Durable Objects, and migrations", () => {
    expect(wrangler).toContain('main = "apps/edge/src/index.ts"');
    expect(wrangler).toContain("[assets]");
    expect(wrangler).toContain('directory = "./apps/web/dist"');
    expect(wrangler).toContain('binding = "ASSETS"');
    expect(wrangler).toContain('not_found_handling = "single-page-application"');
    expect(wrangler).toContain('name = "SESSION_OBJECT"');
    expect(wrangler).toContain('class_name = "SessionDurableObject"');
    expect(wrangler).toContain('name = "SESSION_DIRECTORY"');
    expect(wrangler).toContain('class_name = "SessionDirectory"');
    expect(wrangler).toContain('new_sqlite_classes = ["SessionDurableObject", "SessionDirectory"]');
  });

  test("Cloudflare dev and deploy scripts build SPA assets before Worker commands", () => {
    expect(rootPackage.scripts["dev:cloudflare"]).toMatch(
      /bun run --filter @p2pfile\/web build && bun run --filter @p2pfile\/edge dev/,
    );
    expect(rootPackage.scripts["deploy:cloudflare"]).toMatch(
      /bun run --filter @p2pfile\/web build && bun run --filter @p2pfile\/edge deploy/,
    );
    expect(edgePackage.scripts.deploy).toBe("wrangler deploy");
    expect(edgePackage.scripts.dev).toBe("wrangler dev --local");
    expect(justfile).toContain("dev:\n  bun run dev:cloudflare");
    expect(justfile).toContain("deploy-cloudflare:\n  bun run deploy:cloudflare");
  });

  test("approved Cloudflare command surface has no Bun signal, Redis, Docker, or nginx dependency", () => {
    const cloudflareCommands = [
      rootPackage.scripts["dev:cloudflare"],
      rootPackage.scripts["deploy:cloudflare"],
      edgePackage.scripts.dev,
      edgePackage.scripts.deploy,
      justfile.slice(justfile.indexOf("dev:"), justfile.indexOf("lint:")),
    ].join("\n");

    for (const term of forbiddenCloudflareRouteTerms) {
      expect(cloudflareCommands).not.toContain(term);
    }
    expect(cloudflareCommands).not.toMatch(/hono/i);
  });
});

describe("Cloudflare docs and local smoke", () => {
  test("README points deployment at same-origin Worker assets, API, WebSocket, and SPA fallback", () => {
    const cloudflareSection = readme.slice(
      readme.indexOf("## Cloudflare deployment"),
      readme.indexOf("## Validation commands"),
    );
    expect(cloudflareSection).toContain("wrangler.toml");
    expect(cloudflareSection).toContain("bun run deploy:cloudflare");
    expect(cloudflareSection).toContain("/api/*");
    expect(cloudflareSection).toContain("/ws/*");
    expect(cloudflareSection).toContain("single-page-application");
    for (const term of forbiddenCloudflareRouteTerms) {
      expect(cloudflareSection).not.toContain(term);
    }
    expect(cloudflareSection).not.toMatch(/upload-to-cloud fallback/i);
  });

  test("Worker smoke covers SPA, status, session, claim, signaling, relay, completion, and terminal states", () => {
    expect(workerSmoke).toContain(
      "Worker same-origin Share Link opens metadata-only Frozen Manifest",
    );
    expect(workerSmoke).toContain("/api/status");
    expect(workerSmoke).toContain("createSession(page");
    expect(workerSmoke).toContain('getByTestId("claim-session-button").click()');
    expect(workerSmoke).toContain("Worker Direct Transfer completes");
    expect(workerSmoke).toContain("Worker forced direct failure falls back to Relayed Transfer");
    expect(workerSmoke).toContain("Completed Session View");
    expect(workerSmoke).toContain("Worker sender exit creates Sender-Ended Session");
  });
});
