import { resolve } from "node:path";
import type { Plugin, WorkspaceConfig } from "@lo1/sdk";
import type { EndpointRegistry } from "../discovery/registry";
import { createLog } from "../debug";
import { runServicePreStop } from "./stop";
import type { ComposeContext, ServiceHandle } from "./service";
import type { OrchestratorDeps, OrchestratorEvent } from "./types";

const debug = createLog("orchestrator:restart");

/** Everything needed to start a service again outside the initial `lo1 up`. */
export type RestartContext = {
  config: WorkspaceConfig;
  workspaceDir: string;
  registry: EndpointRegistry;
  plugins: Map<string, Plugin>;
  pluginEnvVars: Record<string, string>;
  compose: ComposeContext;
  /** Restarted host processes outlive the command that restarted them. */
  detached: boolean;
  signal?: AbortSignal;
  emit: (event: OrchestratorEvent) => void;
  deps: Pick<OrchestratorDeps, "startService" | "executeHook">;
};

/**
 * Stops a service (running its preStop hook) and starts it again, waiting
 * for it to be ready. An init task is simply run again and waited on.
 */
export async function restartService(
  name: string,
  current: ServiceHandle | undefined,
  ctx: RestartContext,
): Promise<ServiceHandle> {
  const serviceConfig = ctx.config.services[name];
  debug("restartService: %s (init task: %s)", name, serviceConfig.initTask);

  if (current?.running && !serviceConfig.initTask) {
    ctx.emit({ kind: "service", service: name, status: "stopping" });
    await runServicePreStop({
      handle: current,
      config: ctx.config,
      workspaceDir: ctx.workspaceDir,
      pluginEnvVars: ctx.pluginEnvVars,
      executeHook: ctx.deps.executeHook,
      emit: ctx.emit,
      signal: ctx.signal,
    });
    await current.stop();
    current.releaseLogs?.();
    ctx.emit({ kind: "service", service: name, status: "stopped" });
  }

  ctx.emit({ kind: "service", service: name, status: "starting" });
  const handle = await ctx.deps.startService({
    serviceName: name,
    serviceConfig,
    config: ctx.config,
    plugin: ctx.plugins.get(serviceConfig.type),
    registry: ctx.registry,
    pluginEnvVars: ctx.pluginEnvVars,
    workspaceDir: resolve(ctx.workspaceDir),
    compose: ctx.compose,
    detached: ctx.detached,
    recreate: true,
    signal: ctx.signal,
    onOutput: (line) => ctx.emit({ kind: "output", line }),
    onHookOutput: (output) => ctx.emit({ kind: "hook", hook: name, output }),
  });
  ctx.emit({
    kind: "service",
    service: name,
    status: serviceConfig.initTask ? "completed" : "started",
  });
  return handle;
}
