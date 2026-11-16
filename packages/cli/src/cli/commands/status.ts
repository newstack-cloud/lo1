import { Command } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readState } from "../../orchestrator/state";
import { loadWorkspaceConfig } from "../../config/loader";
import { composePs, type ComposeServiceStatus } from "../../runner/compose";
import { serviceUrl } from "../../proxy/domains";
import type { ServiceState, WorkspaceState } from "../../orchestrator/types";
import type { WorkspaceConfig } from "@lo1/sdk";

export type StatusDeps = {
  readState: (workspaceDir: string) => Promise<WorkspaceState | null>;
  composePs: typeof composePs;
  loadConfig: (configPath?: string) => Promise<WorkspaceConfig>;
  isProcessAlive: (pid: number) => boolean;
  /** Docker's state for a container (`running`, `exited`, …), or null if it doesn't exist. */
  inspectContainer: (nameOrId: string) => Promise<string | null>;
};

export type ServiceRunState = "running" | "starting" | "unhealthy" | "exited";

export type StatusServiceEntry = {
  name: string;
  state: ServiceRunState;
  mode: string;
  port?: number;
  hostPort?: number;
  url?: string;
};

export type InfrastructureState = "healthy" | "starting" | "degraded" | "down" | "none";

export type StatusResult = {
  workspace: string;
  healthy: boolean;
  services: StatusServiceEntry[];
  infrastructure: {
    state: InfrastructureState;
    services: string[];
  };
};

/** Exit codes for `lo1 status`, which agents and scripts rely on. */
export const STATUS_EXIT = { healthy: 0, unhealthy: 1, notRunning: 2 } as const;

function isSettled(s: ComposeServiceStatus): boolean {
  if (s.State === "exited") return s.ExitCode === 0;
  return s.State === "running" && (s.Health === "healthy" || s.Health === "");
}

function expectsInfrastructure(config: WorkspaceConfig | null): boolean {
  if (!config) return true;
  return (
    config.proxy?.enabled !== false ||
    config.extraCompose !== undefined ||
    Object.keys(config.plugins ?? {}).length > 0
  );
}

export function deriveInfraState(
  statuses: ComposeServiceStatus[],
  config: WorkspaceConfig | null,
): InfrastructureState {
  if (statuses.length === 0) return expectsInfrastructure(config) ? "down" : "none";

  // An infrastructure init task that exited 0 has done its job.
  if (statuses.every(isSettled)) return "healthy";

  const anyFailed = statuses.some(
    (s) => s.Health === "unhealthy" || (s.State === "exited" && s.ExitCode !== 0),
  );
  return anyFailed ? "degraded" : "starting";
}

function composeRunState(status: ComposeServiceStatus | undefined): ServiceRunState {
  if (!status || status.State === "exited" || status.State === "dead") return "exited";
  if (status.State !== "running") return "starting";
  if (status.Health === "unhealthy") return "unhealthy";
  if (status.Health === "starting") return "starting";
  return "running";
}

type RunStateContext = {
  name: string;
  svc: ServiceState;
  workspaceName: string;
  composeByService: Map<string, ComposeServiceStatus>;
  deps: StatusDeps;
};

async function resolveRunState(ctx: RunStateContext): Promise<ServiceRunState> {
  const { name, svc, deps } = ctx;
  if (svc.runner === "process") {
    return svc.pid !== undefined && deps.isProcessAlive(svc.pid) ? "running" : "exited";
  }
  if (svc.runner === "container") {
    const state = await deps.inspectContainer(
      svc.containerId ?? `lo1-${ctx.workspaceName}-${name}`,
    );
    return state === "running" ? "running" : "exited";
  }
  return composeRunState(ctx.composeByService.get(name));
}

async function loadConfigOrNull(deps: StatusDeps): Promise<WorkspaceConfig | null> {
  try {
    return await deps.loadConfig();
  } catch {
    return null;
  }
}

export async function getWorkspaceStatus(
  workspaceDir: string,
  deps: StatusDeps,
): Promise<StatusResult | null> {
  const state = await deps.readState(workspaceDir);
  if (!state) return null;

  const config = await loadConfigOrNull(deps);
  const statuses = await deps.composePs({
    projectName: state.projectName,
    fileArgs: state.fileArgs,
    cwd: state.workspaceDir,
  });
  const composeByService = new Map(statuses.map((s) => [s.Service, s]));

  const services: StatusServiceEntry[] = [];
  for (const [name, svc] of Object.entries(state.services)) {
    const svcConfig = config?.services[name];
    // Init tasks have finished by the time the workspace is ready.
    if (svcConfig?.initTask) continue;

    const runState = await resolveRunState({
      name,
      svc,
      workspaceName: state.workspaceName,
      composeByService,
      deps,
    });
    const hostPort =
      svcConfig?.mode === "container" ? (svcConfig.hostPort ?? svcConfig.port) : svcConfig?.port;
    const url = config ? serviceUrl(config, name) : undefined;
    services.push({
      name,
      state: runState,
      mode: svcConfig?.mode ?? svc.runner,
      ...(svcConfig?.port !== undefined && { port: svcConfig.port }),
      ...(hostPort !== undefined && { hostPort }),
      ...(url !== undefined && { url }),
    });
  }

  const infraStatuses = statuses.filter((s) => !(s.Service in state.services));
  const infraState = deriveInfraState(infraStatuses, config);
  const healthy =
    services.every((s) => s.state === "running") &&
    (infraState === "healthy" || infraState === "none");

  return {
    workspace: state.workspaceName,
    healthy,
    services,
    infrastructure: { state: infraState, services: infraStatuses.map((s) => s.Service) },
  };
}

const execAsync = promisify(execFile);

const defaultDeps: StatusDeps = {
  readState,
  composePs,
  loadConfig: loadWorkspaceConfig,
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  inspectContainer: async (nameOrId) => {
    try {
      const { stdout } = await execAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Status}}",
        nameOrId,
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  },
};

export function formatStatus(result: StatusResult): string {
  const lines = [`Workspace: ${result.workspace} (${result.healthy ? "healthy" : "not healthy"})`];

  if (result.infrastructure.services.length > 0) {
    lines.push("", `Infrastructure: ${result.infrastructure.state}`);
    for (const name of result.infrastructure.services) lines.push(`  ${name}`);
  }

  if (result.services.length > 0) {
    lines.push("", "Services:");
    const nameWidth = Math.max(...result.services.map((s) => s.name.length)) + 2;
    const stateWidth = Math.max(...result.services.map((s) => s.state.length)) + 2;
    for (const svc of result.services) {
      const mode = svc.port ? `${svc.mode}:${svc.port}` : svc.mode;
      const url = svc.url ? `  ${svc.url}` : "";
      lines.push(`  ${svc.name.padEnd(nameWidth)}${svc.state.padEnd(stateWidth)}${mode}${url}`);
    }
  }

  return lines.join("\n") + "\n";
}

export const statusCommand = new Command("status")
  .description("Show the health of the running workspace (exit 0 healthy, 1 not, 2 not running)")
  .action(async function (this: Command) {
    const json = this.optsWithGlobals().json === true;
    const result = await getWorkspaceStatus(process.cwd(), defaultDeps);

    if (!result) {
      const message = "No running workspace found.";
      process.stdout.write(
        json ? JSON.stringify({ error: "NoWorkspace", message }) + "\n" : message + "\n",
      );
      process.exitCode = STATUS_EXIT.notRunning;
      return;
    }

    process.stdout.write(json ? JSON.stringify(result) + "\n" : formatStatus(result));
    process.exitCode = result.healthy ? STATUS_EXIT.healthy : STATUS_EXIT.unhealthy;
  });
