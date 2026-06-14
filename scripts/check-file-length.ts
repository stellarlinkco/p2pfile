import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { readConstraints } from "./read-constraints";

const constraints = readConstraints();
const ignoredDirectories = new Set(constraints.ignoredDirectories);
const codeExtensions: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".js": true,
  ".jsx": true,
  ".css": true,
};
const failures: string[] = [];

function isTestPath(path: string): boolean {
  return (
    path.startsWith("tests/") ||
    path.includes("/tests/") ||
    /\.(test|spec|e2e|cases)\.[jt]sx?$/.test(path)
  );
}

function shouldInspect(path: string): boolean {
  if (path.includes(".bak.")) {
    return false;
  }
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

    const lineCount = readFileSync(fullPath, "utf8").split(/\r?\n/).length;
    const relativePath = relative(process.cwd(), fullPath);
    const limit = isTestPath(relativePath) ? constraints.testMaxLines : constraints.sourceMaxLines;

    if (lineCount > limit) {
      failures.push(`${relativePath} (${lineCount} > ${limit})`);
    }
  }
}

walk(process.cwd());

if (failures.length > 0) {
  console.error("File length guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("File length guard passed.");
