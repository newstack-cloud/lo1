import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadWorkspaceConfig } from "../config/loader";
import { composeDown } from "../runner/compose";
import { removeHosts } from "../hosts/index";
import { executeHook } from "../hooks/executor";
import { readState as defaultReadState, removeState as defaultRemoveState } from "./state";
import type { ServiceHandle } from "./service";
import type { OrchestratorDeps, StopOptions, ServiceState, WorkspaceState } from "./types";

const defaultExec = promisify(execFile);

export type StopDeps = Pick<
  OrchestratorDeps,
  "loadConfig" | "composeDown" | "removeHosts" | "executeHook" | "readState" | "removeState"
> & {
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
};

function createDefaultStopDeps(): StopDeps {
  return {
    loadConfig: loadWorkspaceConfig,
    composeDown,
    removeHosts,
    executeHook,
    readState: defaultReadState,
    removeState: defaultRemoveState,
    exec: defaultExec,
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
      async stop() {
        if (svc.pid) {
          try {
            process.kill(svc.pid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }
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

export async function stopWorkspace(
  options: StopOptions,
  overrides: Partial<StopDeps> = {},
): Promise<void> {
  const deps = { ...createDefaultStopDeps(), ...overrides };
  const emit = options.onEvent ?? (() => {});
  const workspaceDir = options.workspaceDir ?? ".";

  emit({ kind: "phase", phase: "Reading workspace state" });
  const state = await deps.readState(workspaceDir);
  if (!state) {
    emit({ kind: "phase", phase: "No running workspace found" });
    return;
  }

  let config;
  try {
    config = await deps.loadConfig();
  } catch {
    config = null;
  }

  if (config?.hooks?.preStop) {
    emit({ kind: "phase", phase: "Running preStop hook" });
    await deps.executeHook("workspace:preStop", config.hooks.preStop, {
      cwd: workspaceDir,
      env: {},
      signal: options.signal,
      onOutput: (output) => emit({ kind: "hook", hook: "preStop", output }),
    });
  }

  const handles = options.handles ?? hydrateHandles(state, deps.exec);

  if (handles.length > 0) {
    emit({ kind: "phase", phase: "Stopping services" });
    for (const handle of handles) {
      emit({ kind: "service", service: handle.serviceName, status: "stopping" });
      await handle.stop();
      emit({ kind: "service", service: handle.serviceName, status: "stopped" });
    }
  }

  emit({ kind: "phase", phase: "Stopping infrastructure" });
  await deps.composeDown({
    projectName: state.projectName,
    fileArgs: state.fileArgs,
    cwd: state.workspaceDir,
  });

  emit({ kind: "phase", phase: "Removing hosts entries" });
  try {
    await deps.removeHosts();
  } catch {
    // Best-effort — hosts removal may require sudo
  }

  await deps.removeState(workspaceDir);
  emit({ kind: "phase", phase: "Stopped" });
}
