import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { WorkspaceConfig } from "@lo1/sdk";
import { createLog } from "../debug";
import { loadWorkspaceConfig } from "../config/loader";
import { buildEndpointRegistry, buildServiceEnv } from "../discovery/registry";
import { composeDown, removeComposeNetwork } from "../runner/compose";
import { networkId } from "../compose/generate";
import { signalProcessTree } from "../runner/process";
import { executeHook } from "../hooks/executor";
import { readState as defaultReadState, removeState as defaultRemoveState } from "./state";
import type { ServiceHandle } from "./service";
import type {
  OrchestratorDeps,
  OrchestratorEvent,
  StopOptions,
  ServiceState,
  WorkspaceState,
} from "./types";

const debug = createLog("orchestrator");

const defaultExec = promisify(execFile);

export type StopDeps = Pick<
  OrchestratorDeps,
  "loadConfig" | "composeDown" | "executeHook" | "readState" | "removeState"
> & {
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  removeNetwork: (projectName: string, networkKey: string) => Promise<void>;
};

function createDefaultStopDeps(): StopDeps {
  return {
    loadConfig: loadWorkspaceConfig,
    composeDown,
    executeHook,
    readState: defaultReadState,
    removeState: defaultRemoveState,
    exec: defaultExec,
    removeNetwork: (project, key) => removeComposeNetwork(project, key),
  };
}

/**
 * Reconstruct ServiceHandles from persisted WorkspaceState.
 * Used for recovery (e.g. `lo1 down` from a separate terminal) or
 * stale-workspace cleanup before a fresh `lo1 up`.
 */
export function hydrateHandles(
  state: WorkspaceState,
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): ServiceHandle[] {
  const execFn = exec ?? defaultExec;
  return Object.entries(state.services).map(([name, svc]) =>
    hydrateHandle(name, svc, state.workspaceName, execFn),
  );
}

function hydrateHandle(
  name: string,
  svc: ServiceState,
  workspaceName: string,
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): ServiceHandle {
  if (svc.runner === "process") {
    return {
      serviceName: name,
      type: "process",
      pid: svc.pid,
      running: true,
      async stop(timeoutMs = 5000) {
        if (svc.pid) await stopProcessByPid(svc.pid, timeoutMs);
      },
    };
  }

  if (svc.runner === "container") {
    const id = svc.containerId ?? `lo1-${workspaceName}-${name}`;
    return {
      serviceName: name,
      type: "container",
      containerId: svc.containerId,
      running: true,
      async stop(timeoutMs = 10000) {
        const timeoutSec = String(Math.ceil(timeoutMs / 1000));
        try {
          await exec("docker", ["stop", "-t", timeoutSec, id]);
        } catch {
          // Container may have already stopped
        }
        try {
          await exec("docker", ["rm", id]);
        } catch {
          // Container may have already been removed
        }
      },
    };
  }

  // compose-runner services are managed by composeDown
  return {
    serviceName: name,
    type: "compose",
    running: true,
    async stop() {},
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether anything in the process group `pid` leads is still running. Only
 * ESRCH means the group is gone; any other error (EPERM) means it may exist.
 */
export function isGroupAlive(pid: number, kill: typeof process.kill = process.kill): boolean {
  try {
    kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Detached services lead their own process group; on Windows there are no groups. */
function isTreeAlive(pid: number): boolean {
  if (platform() === "win32") return isAlive(pid);
  return isGroupAlive(pid) || isAlive(pid);
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    signalProcessTree(pid, signal);
  } catch {
    // Process may have already exited
  }
}

/**
 * Stops a process lo1 did not spawn in this run, waiting for it and its
 * children to exit so its port is free again, and killing whatever is left
 * of the group if it outlasts the timeout.
 */
async function stopProcessByPid(pid: number, timeoutMs: number): Promise<void> {
  trySignal(pid, "SIGTERM");

  const deadline = Date.now() + timeoutMs;
  while (isTreeAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isTreeAlive(pid)) trySignal(pid, "SIGKILL");
}

/**
 * Processes recorded in the state file that the caller holds no handle for,
 * such as a service `lo1 restart` started while `lo1 up` was in the foreground.
 */
function untrackedProcessHandles(
  state: WorkspaceState,
  known: ServiceHandle[],
  exec: StopDeps["exec"],
): ServiceHandle[] {
  const knownPids = new Set(known.map((h) => h.pid).filter((pid) => pid !== undefined));
  return hydrateHandles(state, exec).filter(
    (h) => h.type === "process" && h.pid !== undefined && !knownPids.has(h.pid),
  );
}

type StopServicesContext = Omit<ServicePreStopContext, "handle" | "config"> & {
  config: WorkspaceConfig | null;
};

/** Stops each service, running its preStop hook first while it is still running. */
async function stopServiceHandles(
  handles: ServiceHandle[],
  ctx: StopServicesContext,
): Promise<void> {
  if (handles.length === 0) return;

  ctx.emit({ kind: "phase", phase: "Stopping services" });
  for (const handle of handles) {
    // Finished init tasks and replaced processes have nothing left to stop.
    if (handle.type === "process" && !handle.running) continue;
    ctx.emit({ kind: "service", service: handle.serviceName, status: "stopping" });
    if (ctx.config && handle.running) {
      await runServicePreStop({ ...ctx, handle, config: ctx.config });
    }
    await handle.stop();
    ctx.emit({ kind: "service", service: handle.serviceName, status: "stopped" });
  }
}

export async function stopWorkspace(
  options: StopOptions,
  overrides: Partial<StopDeps> = {},
): Promise<void> {
  const deps = { ...createDefaultStopDeps(), ...overrides };
  const emit = options.onEvent ?? (() => {});
  const workspaceDir = options.workspaceDir ?? ".";
  debug("stopWorkspace: dir=%s", workspaceDir);

  emit({ kind: "phase", phase: "Reading workspace state" });
  const state = await deps.readState(workspaceDir);
  if (!state) {
    emit({ kind: "phase", phase: "No running workspace found" });
    return;
  }

  const config = await deps.loadConfig().catch(() => null);

  if (config?.hooks?.preStop) {
    emit({ kind: "phase", phase: "Running preStop hook" });
    await deps.executeHook("workspace:preStop", config.hooks.preStop, {
      cwd: workspaceDir,
      env: {},
      signal: options.signal,
      onOutput: (output) => emit({ kind: "hook", hook: "preStop", output }),
    });
  }

  const handles = options.handles
    ? [...options.handles, ...untrackedProcessHandles(state, options.handles, deps.exec)]
    : hydrateHandles(state, deps.exec);
  debug("stopWorkspace: %d handles to stop", handles.length);

  await stopServiceHandles(handles, {
    config,
    workspaceDir,
    pluginEnvVars: state.pluginEnvVars ?? {},
    executeHook: deps.executeHook,
    emit,
    signal: options.signal,
  });

  const phase = options.clean
    ? "Removing infrastructure (volumes + orphans)"
    : "Stopping infrastructure";
  emit({ kind: "phase", phase });
  await deps.composeDown({
    projectName: state.projectName,
    fileArgs: state.fileArgs,
    cwd: state.workspaceDir,
    clean: options.clean,
  });
  await deps.removeNetwork(state.projectName, networkId(state.workspaceName));

  await deps.removeState(workspaceDir);
  emit({ kind: "phase", phase: "Stopped" });
}

export type ServicePreStopContext = {
  handle: ServiceHandle;
  config: WorkspaceConfig;
  workspaceDir: string;
  /** The plugin variables the service was started with, as its other hooks get them. */
  pluginEnvVars?: Record<string, string>;
  executeHook: OrchestratorDeps["executeHook"];
  emit: (event: OrchestratorEvent) => void;
  signal?: AbortSignal;
};

/**
 * Runs a service's preStop hook with the same environment its other hooks get.
 * A failing hook is reported but does not stop the rest of the teardown.
 */
export async function runServicePreStop(ctx: ServicePreStopContext): Promise<void> {
  const name = ctx.handle.serviceName;
  const service = ctx.config.services[name];
  const command = service?.hooks?.preStop;
  if (!command) return;

  const consumerMode = ctx.handle.type === "process" ? "host" : "container";
  const registry = buildEndpointRegistry(ctx.config);
  const pluginEnvVars = ctx.pluginEnvVars ?? {};
  const env = buildServiceEnv(name, service, ctx.config, registry, pluginEnvVars, consumerMode);

  try {
    await ctx.executeHook(`${name}:preStop`, command, {
      cwd: resolve(ctx.workspaceDir, service.path),
      env,
      signal: ctx.signal,
      onOutput: (output) => ctx.emit({ kind: "hook", hook: name, output }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.emit({ kind: "error", message: `preStop hook for "${name}" failed: ${message}` });
  }
}
