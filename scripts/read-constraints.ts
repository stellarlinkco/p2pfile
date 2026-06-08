import { readFileSync } from "node:fs";

export type Constraints = {
  sourceMaxLines: number;
  testMaxLines: number;
  forbiddenNameSuffixes: string[];
  ignoredDirectories: string[];
  dependencyBoundaryRules: Record<string, string[]>;
};

function parseScalar(text: string, key: string): number {
  const match = text.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m"));
  if (!match) {
    throw new Error(`Missing numeric constraint: ${key}`);
  }
  return Number(match[1]);
}

function parseList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const values: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/^[A-Za-z0-9_]+:\s*$/.test(line)) {
      inSection = line.startsWith(`${key}:`);
      continue;
    }

    if (inSection) {
      if (/^ {2}- /.test(line)) {
        values.push(line.trim().slice(2).replace(/^"|"$/g, ""));
        continue;
      }

      if (/^[^ ]/.test(line) && line.trim().length > 0) {
        break;
      }
    }
  }

  return values;
}

function parseBoundaryRules(text: string): Record<string, string[]> {
  const lines = text.split(/\r?\n/);
  const rules: Record<string, string[]> = {};
  let inSection = false;
  let currentKey: string | null = null;

  for (const line of lines) {
    if (/^[A-Za-z0-9_]+:\s*$/.test(line)) {
      if (line.startsWith("dependency_boundary_rules:")) {
        inSection = true;
        currentKey = null;
        continue;
      }

      if (inSection) {
        break;
      }
    }

    if (!inSection) {
      continue;
    }

    const keyMatch = line.match(/^ {2}"?([^"]+)"?:\s*$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      rules[currentKey] = [];
      continue;
    }

    const valueMatch = line.match(/^ {4}- "?([^"]+)"?\s*$/);
    if (valueMatch && currentKey) {
      rules[currentKey].push(valueMatch[1]);
    }
  }

  return rules;
}

export function readConstraints(): Constraints {
  const text = readFileSync("constraints.yaml", "utf8");
  return {
    sourceMaxLines: parseScalar(text, "source_max_lines"),
    testMaxLines: parseScalar(text, "test_max_lines"),
    forbiddenNameSuffixes: parseList(text, "forbidden_name_suffixes"),
    ignoredDirectories: parseList(text, "ignored_directories"),
    dependencyBoundaryRules: parseBoundaryRules(text),
  };
}
