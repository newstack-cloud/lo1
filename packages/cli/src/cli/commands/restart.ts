import { Command } from "commander";
import type { Plugin, WorkspaceConfig } from "@lo1/sdk";
import { loadWorkspaceConfig } from "../../config/loader";
import { buildEndpointRegistry } from "../../discovery/registry";
import { Lo1Error } from "../../errors";
import { executeHook } from "../../hooks/executor";
import { appendLog } from "../../logs/writer";
import { createEventFormatter } from "../../output/format";
import { loadPlugins } from "../../plugin/loader";
import { restartService } from "../../orchestrator/restart";
import { startService, BUILTIN_TYPES } from "../../orchestrator/service";
import { applyModeOverride, buildServiceState, createLogger } from "../../orchestrator/start";
import { readState, writeState } from "../../orchestrator/state";
import { hydrateHandles } from "../../orchestrator/stop";
import type { OrchestratorEvent, WorkspaceState } from "../../orchestrator/types";

export class RestartError extends Lo1Error {
  constructor(message: string, code = "RestartError") {
    super(message, code);
    this.name = "RestartError";
  }
}

export function validateRestartTargets(names: string[], config: WorkspaceConfig): void {
  for (const name of names) {
    const service = config.services[name];
    if (!service) {
      throw new RestartError(`Unknown service "${name}". Check the services in lo1.yaml.`);
    }
    if (service.mode === "skip") {
      throw new RestartError(`Service "${name}" has mode: skip, so lo1 does not run it.`);
    }
  }
}

async function loadNeededPlugins(
  names: string[],
  config: WorkspaceConfig,
  workspaceDir: string,
  emit: (event: OrchestratorEvent) => void,
): Promise<Map<string, Plugin>> {
  const needsPlugins = names.some((name) => !BUILTIN_TYPES.has(config.services[name].type));
  if (!needsPlugins) return new Map();
  return loadPlugins(config.plugins ?? {}, {
    workspaceDir,
    workspaceName: config.name,
    logger: createLogger(emit),
  });
}

function createRestartEventHandler(workspaceDir: string): (event: OrchestratorEvent) => void {
  const format = createEventFormatter();
  return (event) => {
    if (event.kind === "output") {
      void appendLog(workspaceDir, event.line.service, event.line.text).catch(() => {});
    } else if (event.kind === "hook") {
      void appendLog(workspaceDir, "hooks", event.output.text).catch(() => {});
    }
    const message = format(event);
    if (message) process.stdout.write(message.trimEnd() + "\n");
  };
}

async function requireRunningWorkspace(workspaceDir: string): Promise<WorkspaceState> {
  const state = await readState(workspaceDir);
  if (!state) {
    throw new RestartError("No running workspace found. Start one with lo1 up.", "NoWorkspace");
  }
  return state;
}

export const restartCommand = new Command("restart")
  .description("Restart services, or run init tasks again, in the running workspace")
  .argument("<services...>", "Services or init tasks to restart, in order")
  .action(async (names: string[]) => {
    const workspaceDir = process.cwd();
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());

    const state = await requireRunningWorkspace(workspaceDir);
    const config = applyModeOverride(await loadWorkspaceConfig(), state.modeOverride);
    validateRestartTargets(names, config);

    const emit = createRestartEventHandler(workspaceDir);
    const ctx = {
      config,
      workspaceDir,
      registry: buildEndpointRegistry(config),
      plugins: await loadNeededPlugins(names, config, workspaceDir, emit),
      pluginEnvVars: state.pluginEnvVars ?? {},
      compose: { projectName: state.projectName, fileArgs: state.fileArgs, cwd: workspaceDir },
      detached: true,
      signal: controller.signal,
      emit,
      deps: { startService, executeHook },
    };

    const current = hydrateHandles(state);
    for (const name of names) {
      const handle = await restartService(
        name,
        current.find((h) => h.serviceName === name),
        ctx,
      );
      handle.releaseLogs?.();
      handle.detach?.();

      const { [name]: _previous, ...others } = state.services;
      state.services = { ...others, ...buildServiceState([handle]) };
      await writeState(state, workspaceDir);
    }
  });
