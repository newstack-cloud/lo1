import { Command } from "commander";
import { readState } from "../../orchestrator/state";
import { loadWorkspaceConfig } from "../../config/loader";
import { composePs, type ComposeServiceStatus } from "../../runner/compose";
import type { WorkspaceState } from "../../orchestrator/types";
import type { WorkspaceConfig } from "@lo1/sdk";

export type StatusDeps = {
  readState: (workspaceDir: string) => Promise<WorkspaceState | null>;
  composePs: typeof composePs;
  loadConfig: (configPath?: string) => Promise<WorkspaceConfig>;
};

export type StatusServiceEntry = {
  name: string;
  state: string;
  mode: string;
  port?: number;
  hostPort?: number;
};

export type StatusResult = {
  workspace: string;
  services: StatusServiceEntry[];
  infrastructure: {
    state: string;
    services: string[];
  };
};

function deriveInfraState(statuses: ComposeServiceStatus[]): string {
  if (statuses.length === 0) return "down";

  const allHealthy = statuses.every(
    (s) => s.State === "running" && (s.Health === "healthy" || s.Health === ""),
  );
  if (allHealthy) return "healthy";

  const anyUnhealthy = statuses.some((s) => s.Health === "unhealthy");
  if (anyUnhealthy) return "degraded";

  return "starting";
}

export async function getWorkspaceStatus(
  workspaceDir: string,
  deps: StatusDeps,
): Promise<StatusResult | null> {
  const state = await deps.readState(workspaceDir);
  if (!state) return null;

  let config: WorkspaceConfig | null;
  try {
    config = await deps.loadConfig();
  } catch {
    config = null;
  }

  const statuses = await deps.composePs({
    projectName: state.projectName,
    fileArgs: state.fileArgs,
    cwd: state.workspaceDir,
  });

  const services: StatusServiceEntry[] = [];
  for (const [name, svc] of Object.entries(state.services)) {
    const svcConfig = config?.services[name];
    services.push({
      name,
      state: "running",
      mode: svcConfig?.mode ?? svc.runner,
      ...(svcConfig?.port !== undefined && { port: svcConfig.port }),
      ...(svcConfig?.hostPort !== undefined
        ? { hostPort: svcConfig.hostPort }
        : svcConfig?.port !== undefined
          ? { hostPort: svcConfig.port }
          : {}),
    });
  }

  return {
    workspace: state.workspaceName,
    services,
    infrastructure: {
      state: deriveInfraState(statuses),
      services: statuses.map((s) => s.Service),
    },
  };
}

const defaultDeps: StatusDeps = {
  readState,
  composePs,
  loadConfig: loadWorkspaceConfig,
};

export const statusCommand = new Command("status")
  .description("Show status of all services")
  .action(async function (this: Command) {
    const json = this.optsWithGlobals().json === true;
    const workspaceDir = process.cwd();

    const result = await getWorkspaceStatus(workspaceDir, defaultDeps);

    if (json) {
      if (!result) {
        process.stdout.write(
          JSON.stringify({ error: "NoWorkspace", message: "No running workspace found." }) + "\n",
        );
      } else {
        process.stdout.write(JSON.stringify(result) + "\n");
      }
      return;
    }

    if (!result) {
      console.log("No running workspace found.");
      return;
    }

    console.log(`Workspace: ${result.workspace}\n`);

    if (result.infrastructure.services.length > 0) {
      console.log(`Infrastructure: ${result.infrastructure.state}`);
      for (const name of result.infrastructure.services) {
        console.log(`  ${name}`);
      }
    }

    if (result.services.length > 0) {
      console.log("\nServices:");
      const maxName = Math.max(...result.services.map((s) => s.name.length));
      for (const svc of result.services) {
        const port = svc.port ? `:${svc.port}` : "";
        console.log(`  ${svc.name.padEnd(maxName + 2)} ${svc.mode}${port}`);
      }
    }
  });
