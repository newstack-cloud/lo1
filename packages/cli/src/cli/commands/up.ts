import { Command } from "commander";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { startWorkspace } from "../../orchestrator/start";
import { stopWorkspace } from "../../orchestrator/stop";
import { loadWorkspaceConfig } from "../../config/loader";
import { collectDomains } from "../../proxy/domains";
import { initLogDir, appendLog, logDir } from "../../logs/writer";
import { createEventFormatter } from "../../output/format";
import type { WorkspaceConfig } from "@lo1/sdk";
import type { OrchestratorEvent } from "../../orchestrator/types";

function printReadySummary(config: WorkspaceConfig, workspaceDir: string, detached: boolean): void {
  const tld = config.proxy?.tld ?? "local";
  const tlsEnabled = config.proxy?.tls?.enabled === true;
  const scheme = tlsEnabled ? "https" : "http";
  const lines: string[] = ["", `  Workspace ${config.name} is ready!`, ""];

  const serviceUrls: { name: string; url: string }[] = [];
  for (const [name, service] of Object.entries(config.services)) {
    if (service.mode === "skip" || service.initTask || !service.port) continue;
    const domain = service.proxy?.domain ?? `${name}.${config.name}.${tld}`;
    serviceUrls.push({ name, url: `${scheme}://${domain}` });
  }

  if (serviceUrls.length > 0) {
    lines.push("  Services:");
    const maxName = Math.max(...serviceUrls.map((s) => s.name.length));
    for (const { name, url } of serviceUrls) {
      lines.push(`    ${name.padEnd(maxName + 2)}${url}`);
    }
    lines.push("");
  }

  lines.push(`  Logs:  ${logDir(workspaceDir)}`);
  lines.push("         Run lo1 logs [service] to tail, lo1 logs --list to see available");
  lines.push("");

  if (detached) {
    lines.push("  Run lo1 down to stop");
  } else {
    lines.push("  Press Ctrl+C to stop");
  }
  lines.push("");

  process.stdout.write(lines.join("\n"));
}

async function acquireSudo(): Promise<void> {
  if (platform() === "win32") return;

  const config = await loadWorkspaceConfig();
  const domains = collectDomains(config);
  const needsHosts = domains.length > 0;
  const needsTls = config.proxy?.tls?.enabled && platform() === "linux";

  if (!needsHosts && !needsTls) return;

  const reasons: string[] = [];
  if (needsHosts) reasons.push("update /etc/hosts");
  if (needsTls) reasons.push("trust TLS certificates");

  console.log(`lo1 needs sudo to ${reasons.join(" and ")}.\n`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("/usr/bin/sudo", ["-v"], { stdio: "inherit" });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("sudo authentication failed")),
    );
    proc.on("error", reject);
  });

  console.log();
}

function waitForShutdownSignal(controller: AbortController): Promise<void> {
  if (controller.signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    // setInterval keeps Bun's event loop alive so the process doesn't exit
    const keepAlive = setInterval(() => {}, 60_000);
    controller.signal.addEventListener(
      "abort",
      () => {
        clearInterval(keepAlive);
        resolve();
      },
      { once: true },
    );
  });
}

type TeardownOptions = {
  workspaceDir: string;
  handles?: Awaited<ReturnType<typeof startWorkspace>>["handles"];
  logsHandle?: { kill: () => void };
  skipTeardown: boolean;
  clean: boolean;
  onEvent: (event: OrchestratorEvent) => void;
};

async function teardown(opts: TeardownOptions): Promise<void> {
  opts.logsHandle?.kill();

  if (opts.skipTeardown) {
    opts.onEvent({
      kind: "phase",
      phase: "Skipping teardown (--skip-teardown). Run lo1 down to clean up.",
    });
    return;
  }

  opts.onEvent({ kind: "phase", phase: "Shutting down..." });
  try {
    await stopWorkspace({
      workspaceDir: opts.workspaceDir,
      handles: opts.handles,
      clean: opts.clean,
      onEvent: opts.onEvent,
    });
  } catch {
    // Best-effort shutdown
  }
}

export const upCommand = new Command("up")
  .description("Start all services and infrastructure")
  .option("--services <names>", "Comma-separated list of services to start")
  .option("--mode <mode>", "Override service mode (dev|container)")
  .option("-d, --detach", "Start in the background and exit")
  .option("--skip-teardown", "Leave containers running on exit (useful for debugging)")
  .option("--clean", "Remove volumes and orphan containers on teardown")
  .action(async (options) => {
    const detached = options.detach === true;
    const skipTeardown = options.skipTeardown === true;
    const clean = options.clean === true;
    const controller = new AbortController();

    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());

    const serviceFilter = options.services
      ? (options.services as string).split(",").map((s: string) => s.trim())
      : undefined;

    const modeOverride = options.mode as "dev" | "container" | undefined;
    const workspaceDir = process.cwd();

    await acquireSudo();
    await initLogDir(workspaceDir);

    const formatEvent = createEventFormatter();
    // After startup completes, suppress service output from stdout.
    // Logs still go to .lo1/logs/ — use `lo1 logs` to tail.
    let logOnly = false;
    const onEvent = (event: OrchestratorEvent) => {
      if (event.kind === "output") {
        void appendLog(workspaceDir, event.line.service, event.line.text).catch(() => {});
        if (logOnly || event.line.service.endsWith("-proxy")) return;
      } else if (event.kind === "hook") {
        void appendLog(workspaceDir, "hooks", event.output.text).catch(() => {});
      }

      const msg = formatEvent(event);
      if (msg) process.stdout.write(msg.trimEnd() + "\n");
    };

    let result: Awaited<ReturnType<typeof startWorkspace>> | undefined;
    let startupError: unknown;
    try {
      result = await startWorkspace({
        workspaceDir,
        serviceFilter,
        modeOverride,
        signal: controller.signal,
        onEvent,
      });

      logOnly = true;
      printReadySummary(result.config, workspaceDir, detached);

      if (detached) {
        result.logsHandle.kill();
        return;
      }

      await waitForShutdownSignal(controller);
    } catch (err) {
      if (!controller.signal.aborted) {
        startupError = err;
      }
    }

    await teardown({
      workspaceDir,
      handles: result?.handles,
      logsHandle: result?.logsHandle,
      skipTeardown,
      clean,
      onEvent,
    });

    if (startupError) throw startupError;
  });
