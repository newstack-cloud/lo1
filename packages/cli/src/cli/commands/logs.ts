import { Command } from "commander";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { platform } from "node:os";
import { logDir } from "../../logs/writer";

async function listLogFiles(workspaceDir: string): Promise<string[]> {
  const dir = logDir(workspaceDir);
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".log")).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function tailFile(filePath: string, prefix: string, signal: AbortSignal): void {
  const isWindows = platform() === "win32";
  // Use absolute paths to avoid searching PATH (security-sensitive)
  const child = isWindows
    ? spawn(
      join(
        process.env.SYSTEMROOT ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-Command", `Get-Content -Path '${filePath}' -Wait -Tail 50`],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    : spawn("/usr/bin/tail", ["-n", "50", "-f", filePath], {
      stdio: ["ignore", "pipe", "ignore"],
    });

  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`[${prefix}] ${line}\n`);
    }
  });

  const onAbort = () => child.kill("SIGTERM");
  if (signal.aborted) {
    child.kill("SIGTERM");
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
}

export const logsCommand = new Command("logs")
  .description("Tail log files from the most recent lo1 up session")
  .argument("[service]", "Service name to tail (omit for all)")
  .option("--list", "List available log files")
  .action(async (service: string | undefined, options: { list?: boolean }) => {
    const workspaceDir = process.cwd();
    const files = await listLogFiles(workspaceDir);

    if (files.length === 0) {
      console.log("No log files found. Run `lo1 up` first.");
      return;
    }

    if (options.list) {
      console.log("Available log files:");
      for (const f of files) {
        console.log(`  ${basename(f, ".log")}`);
      }
      return;
    }

    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());

    if (service) {
      const match = files.find((f) => basename(f, ".log") === service);
      if (!match) {
        console.error(`No log file found for "${service}". Use --list to see available logs.`);
        process.exitCode = 1;
        return;
      }
      tailFile(join(logDir(workspaceDir), match), service, controller.signal);
    } else {
      for (const f of files) {
        const name = basename(f, ".log");
        tailFile(join(logDir(workspaceDir), f), name, controller.signal);
      }
    }

    // Keep alive until interrupted
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
