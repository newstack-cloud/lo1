import { Command } from "commander";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { buildServiceState, startWorkspace } from "../../orchestrator/start";
import { hydrateHandles, stopWorkspace } from "../../orchestrator/stop";
import { watchPluginServices } from "../../orchestrator/watch";
import { withWorkspaceLock } from "../../orchestrator/lock";
import { readState, writeState } from "../../orchestrator/state";
import { startService, type ServiceHandle } from "../../orchestrator/service";
import { executeHook } from "../../hooks/executor";
import { loadWorkspaceConfig } from "../../config/loader";
import { collectDomains, serviceUrl } from "../../proxy/domains";
import { initLogDir, appendLog, logDir } from "../../logs/writer";
import { createEventFormatter } from "../../output/format";
import type { WorkspaceConfig } from "@lo1/sdk";
import type { OrchestratorEvent, StartResult } from "../../orchestrator/types";

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

type ReadyResult = Pick<StartResult, "config" | "timings">;

function readyServices(config: WorkspaceConfig): { name: string; url: string }[] {
  return Object.keys(config.services).flatMap((name) => {
    const url = serviceUrl(config, name);
    return url ? [{ name, url }] : [];
  });
}

export function formatReadySummary(
  result: ReadyResult,
  workspaceDir: string,
  detached: boolean,
): string {
  const { config, timings } = result;
  const breakdown = timings.phases.map((p) => `${p.name} ${formatSeconds(p.ms)}`).join(" · ");
  const lines: string[] = [
    "",
    `  Workspace ${config.name} is ready in ${formatSeconds(timings.totalMs)}`,
    `    ${breakdown}`,
    "",
  ];

  const services = readyServices(config);
  if (services.length > 0) {
    lines.push("  Services:");
    const maxName = Math.max(...services.map((s) => s.name.length));
    for (const { name, url } of services) {
      lines.push(`    ${name.padEnd(maxName + 2)}${url}`);
    }
    lines.push("");
  }

  lines.push(`  Logs:  ${logDir(workspaceDir)}`);
  lines.push("         Run lo1 logs [service] to tail, lo1 logs --list to see available");
  lines.push("");
  lines.push(detached ? "  Run lo1 down to stop" : "  Press Ctrl+C to stop");
  lines.push("");

  return lines.join("\n");
}

/** The one line `lo1 --json up` prints to stdout once the workspace is ready. */
export function buildReadyJson(result: ReadyResult, workspaceDir: string, detached: boolean) {
  return {
    workspace: result.config.name,
    ready: true,
    detached,
    durationMs: result.timings.totalMs,
    phases: result.timings.phases,
    services: readyServices(result.config),
    logs: logDir(workspaceDir),
  };
}

/** Exit code when Ctrl+C interrupts startup before the workspace is ready. */
export const EXIT_INTERRUPTED = 130;

async function acquireSudo(): Promise<void> {
  if (platform() === "win32") return;

  const config = await loadWorkspaceConfig();
  const domains = collectDomains(config);
  const needsHosts = domains.length > 0;
  const needsTls =
    config.proxy?.enabled !== false && config.proxy?.tls?.enabled && platform() === "linux";

  if (!needsHosts && !needsTls) return;

  const reasons: string[] = [];
  if (needsHosts) reasons.push("update /etc/hosts");
  if (needsTls) reasons.push("trust TLS certificates");

  console.error(`lo1 needs sudo to ${reasons.join(" and ")}.\n`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("/usr/bin/sudo", ["-v"], { stdio: "inherit" });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("sudo authentication failed")),
    );
    proc.on("error", reject);
  });

  console.error();
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

/** A service's handle as the state file records it, if the workspace is still running. */
export async function recordedHandle(
  workspaceDir: string,
  name: string,
): Promise<ServiceHandle | undefined> {
  const state = await readState(workspaceDir);
  if (!state?.services[name]) return undefined;
  return hydrateHandles({ ...state, services: { [name]: state.services[name] } })[0];
}

/** Points the state file at a service's new process after the watcher restarts it. */
export async function recordReplacement(
  workspaceDir: string,
  handle: ServiceHandle,
): Promise<void> {
  const state = await readState(workspaceDir);
  if (!state) return;
  const { [handle.serviceName]: _previous, ...others } = state.services;
  await writeState(
    { ...state, services: { ...others, ...buildServiceState([handle]) } },
    workspaceDir,
  );
}

export const upCommand = new Command("up")
  .description("Start all services and infrastructure")
  .option("--services <names>", "Comma-separated list of services to start")
  .option("--mode <mode>", "Override service mode (dev|container)")
  .option("-d, --detach", "Start in the background and exit")
  .option("--skip-teardown", "Leave containers running on exit (useful for debugging)")
  .option("--clean", "Remove volumes and orphan containers on teardown")
  .action(async function (this: Command, options) {
    const json = this.optsWithGlobals().json === true;
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
      // With --json, stdout carries only the final JSON line; progress goes to stderr.
      if (msg) (json ? process.stderr : process.stdout).write(msg.trimEnd() + "\n");
    };

    let result: Awaited<ReturnType<typeof startWorkspace>> | undefined;
    let startupError: unknown;
    try {
      result = await startWorkspace({
        workspaceDir,
        serviceFilter,
        modeOverride,
        detached,
        signal: controller.signal,
        onEvent,
      });

      logOnly = true;
      if (json) {
        process.stdout.write(JSON.stringify(buildReadyJson(result, workspaceDir, detached)) + "\n");
      } else {
        process.stdout.write(formatReadySummary(result, workspaceDir, detached));
      }

      if (detached) {
        result.logsHandle.kill();
        for (const handle of result.handles) handle.detach?.();
        return;
      }

      const watcher = watchPluginServices(
        result.handles,
        {
          config: result.config,
          workspaceDir,
          registry: result.registry,
          plugins: result.plugins,
          pluginEnvVars: result.pluginEnvVars,
          compose: result.compose,
          detached: false,
          signal: controller.signal,
          emit: onEvent,
          deps: { startService, executeHook },
        },
        {
          runExclusive: (fn) => withWorkspaceLock(workspaceDir, fn),
          onReplaced: (handle) => recordReplacement(workspaceDir, handle),
          recordedHandle: (name) => recordedHandle(workspaceDir, name),
        },
      );
      await waitForShutdownSignal(controller);
      // Let a restart under way finish, so teardown sees its new process.
      await watcher.stop();
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
    if (!result) process.exitCode = EXIT_INTERRUPTED;
  });
