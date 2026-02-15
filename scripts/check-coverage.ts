#!/usr/bin/env bun
/**
 * Aggregate coverage threshold check.
 *
 * Runs `bun test --coverage` and validates aggregate line/function
 * coverage against thresholds. Works around Bun's per-file threshold
 * enforcement (oven-sh/bun#17028) by parsing lcov output instead.
 */

const THRESHOLDS = {
  lines: 80,
  functions: 73,
};

const LCOV_PATH = "coverage/lcov.info";

async function runTests(): Promise<boolean> {
  const proc = Bun.spawn(["bun", "test", "--coverage"], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: import.meta.dir + "/..",
  });
  const code = await proc.exited;
  return code === 0;
}

async function parseLcov(path: string): Promise<{ lines: number; functions: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`Coverage file not found: ${path}`);
    process.exit(1);
  }

  const text = await file.text();
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("LF:")) linesFound += Number.parseInt(line.slice(3));
    else if (line.startsWith("LH:")) linesHit += Number.parseInt(line.slice(3));
    else if (line.startsWith("FNF:")) functionsFound += Number.parseInt(line.slice(4));
    else if (line.startsWith("FNH:")) functionsHit += Number.parseInt(line.slice(4));
  }

  return {
    lines: linesFound > 0 ? (linesHit / linesFound) * 100 : 0,
    functions: functionsFound > 0 ? (functionsHit / functionsFound) * 100 : 0,
  };
}

async function main() {
  const passed = await runTests();
  if (!passed) {
    process.exit(1);
  }

  const coverage = await parseLcov(LCOV_PATH);
  let failed = false;

  console.log("\nCoverage thresholds (aggregate):");
  for (const [metric, threshold] of Object.entries(THRESHOLDS) as [keyof typeof THRESHOLDS, number][]) {
    const actual = coverage[metric];
    const ok = actual >= threshold;
    const icon = ok ? "PASS" : "FAIL";
    console.log(`  ${icon}  ${metric}: ${actual.toFixed(1)}% (threshold: ${threshold}%)`);
    if (!ok) failed = true;
  }

  if (failed) {
    process.exit(1);
  }
}

void main();

