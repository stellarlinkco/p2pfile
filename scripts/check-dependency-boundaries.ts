import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { readConstraints } from "./read-constraints";

const constraints = readConstraints();
const ignoredDirectories = new Set(constraints.ignoredDirectories);
const codeExtensions: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".js": true,
  ".jsx": true,
};
const importPattern = /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const failures: string[] = [];

function areaForFile(filePath: string): string | null {
  if (filePath.startsWith("apps/web/")) return "apps/web";
  if (filePath.startsWith("apps/signal/")) return "apps/signal";
  if (filePath.startsWith("packages/shared/")) return "packages/shared";
  return null;
}

function areaForSpecifier(filePath: string, specifier: string): string | null {
  if (specifier.startsWith("@p2pfile/shared")) return "packages/shared";
  if (specifier === "@p2pfile/web" || specifier.startsWith("@p2pfile/web/")) return "apps/web";
  if (specifier === "@p2pfile/signal" || specifier.startsWith("@p2pfile/signal/"))
    return "apps/signal";

  if (!specifier.startsWith(".")) {
    return null;
  }

  const importerDirectory = dirname(resolve(filePath));
  const targetPath = resolve(importerDirectory, specifier);
  const relativeTarget = relative(process.cwd(), targetPath).replaceAll("\\", "/");

  if (relativeTarget.startsWith("apps/web/")) return "apps/web";
  if (relativeTarget.startsWith("apps/signal/")) return "apps/signal";
  if (relativeTarget.startsWith("packages/shared/")) return "packages/shared";
  return null;
}

function shouldInspect(path: string): boolean {
  if (path.includes(".bak.")) return false;
  return codeExtensions[extname(path)] === true;
}

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirectories.has(entry) || entry.includes(".bak.")) {
      continue;
    }

    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!shouldInspect(fullPath)) {
      continue;
    }

    const relativePath = relative(process.cwd(), fullPath).replaceAll("\\", "/");
    const sourceArea = areaForFile(relativePath);
    if (!sourceArea) {
      continue;
    }

    const forbiddenTargets = constraints.dependencyBoundaryRules[sourceArea] ?? [];
    const source = readFileSync(fullPath, "utf8");

    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) {
        continue;
      }

      const targetArea = areaForSpecifier(relativePath, specifier);
      if (!targetArea) {
        continue;
      }

      if (forbiddenTargets.includes(targetArea)) {
        failures.push(`${relativePath} -> ${specifier}`);
      }
    }
  }
}

walk(process.cwd());

if (failures.length > 0) {
  console.error("Dependency boundary guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Dependency boundary guard passed.");
