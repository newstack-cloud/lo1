import { Command } from "commander";
import { createDefaultDoctorDeps, runDoctor, type CheckResult } from "../../doctor/checks";

const SYMBOLS: Record<CheckResult["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

const COLORS: Record<CheckResult["status"], string> = {
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  fail: "\x1b[31m",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatDoctorReport(results: CheckResult[], useColor: boolean): string {
  const lines = results.map((r) => {
    const symbol = useColor ? `${COLORS[r.status]}${SYMBOLS[r.status]}\x1b[0m` : SYMBOLS[r.status];
    const fix = r.fix ? `\n      ${r.fix}` : "";
    return `  ${symbol} ${r.message}${fix}`;
  });

  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  const summary =
    failures === 0 && warnings === 0
      ? "Everything looks good."
      : [failures > 0 && plural(failures, "problem"), warnings > 0 && plural(warnings, "warning")]
          .filter(Boolean)
          .join(", ") + ".";

  return `${lines.join("\n")}\n\n  ${summary}\n`;
}

export const doctorCommand = new Command("doctor")
  .description("Check that this machine and workspace are ready for lo1 up")
  .option("--config <path>", "Path to lo1.yaml config file", "lo1.yaml")
  .action(async function (this: Command) {
    const { json, config } = this.optsWithGlobals();
    const results = await runDoctor(createDefaultDoctorDeps(config), process.cwd());
    const ok = results.every((r) => r.status !== "fail");

    if (json === true) {
      process.stdout.write(JSON.stringify({ ok, checks: results }) + "\n");
    } else {
      process.stdout.write(formatDoctorReport(results, process.stdout.isTTY === true));
    }

    if (!ok) process.exitCode = 1;
  });
