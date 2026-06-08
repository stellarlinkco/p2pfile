import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { readConstraints } from "./read-constraints";

const constraints = readConstraints();
const ignoredDirectories = new Set(constraints.ignoredDirectories);
const failures: string[] = [];

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

    const stem = basename(entry, extname(entry));
    if (constraints.forbiddenNameSuffixes.some((suffix) => stem.endsWith(suffix))) {
      failures.push(relative(process.cwd(), fullPath));
    }
  }
}

walk(process.cwd());

if (failures.length > 0) {
  console.error("Forbidden filename suffixes detected:");
  for (const file of failures) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log("Filename guard passed.");
