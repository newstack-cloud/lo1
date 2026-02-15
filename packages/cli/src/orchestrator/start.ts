import type { Plugin, PluginContext, WorkspaceConfig, ComposeContribution } from "@lo1/sdk";
import type { EndpointRegistry } from "../discovery/registry";
import { loadWorkspaceConfig } from "../config/loader";
import { buildDag } from "../dag/index";
import { buildEndpointRegistry } from "../discovery/registry";
import { generateCompose, writeComposeFile } from "../compose/generate";
import { generateCaddyfile, writeCaddyfile } from "../proxy/caddyfile";
import { generateHostsBlock, applyHosts } from "../hosts/index";
import { composeUp } from "../runner/compose";
import { loadPlugins } from "../plugin/loader";
import { executeHook } from "../hooks/executor";
import { trustCaddyCa as defaultTrustCaddyCa } from "../tls/setup";
import { startService as defaultStartService, BUILTIN_TYPES } from "./service";
import { writeState as defaultWriteState } from "./state";
import { resolveServiceFilter } from "./filter";
import { hydrateHandles } from "./stop";
import type {
  OrchestratorDeps,
  StartOptions,
  StartResult,
  OrchestratorEvent,
  ServiceState,
} from "./types";
import type { ServiceHandle } from "./service";

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OrchestratorError("Startup aborted");
  }
}

type WorkspaceHookContext = {
  hookName: "postInfrastructure" | "postSetup" | "preStop";
  config: WorkspaceConfig;
  workspaceDir: string;
  pluginEnvVars: Record<string, string>;
  signal?: AbortSignal;
  deps: OrchestratorDeps;
  emit: (event: OrchestratorEvent) => void;
};

type LayerStartContext = {
  layers: string[][];
  config: WorkspaceConfig;
  plugins: Map<string, Plugin>;
  registry: EndpointRegistry;
  pluginEnvVars: Record<string, string>;
  workspaceDir: string;
  signal?: AbortSignal;
  deps: OrchestratorDeps;
  emit: (event: OrchestratorEvent) => void;
};

function createDefaultDeps(): OrchestratorDeps {
  return {
    loadConfig: loadWorkspaceConfig,
    loadPlugins,
    buildDag,
    buildEndpointRegistry,
    generateCompose,
    writeComposeFile,
    generateCaddyfile,
    writeCaddyfile,
    generateHostsBlock,
    applyHosts,
    removeHosts: () => import("../hosts/index").then((m) => m.removeHosts()),
    composeUp,
    composeDown: (opts) => import("../runner/compose").then((m) => m.composeDown(opts)),
    composePs: (opts) => import("../runner/compose").then((m) => m.composePs(opts)),
    startService: defaultStartService,
    executeHook,
    trustCaddyCa: defaultTrustCaddyCa,
    readState: (dir) => import("./state").then((m) => m.readState(dir)),
    writeState: defaultWriteState,
    removeState: (dir) => import("./state").then((m) => m.removeState(dir)),
  };
}

export async function startWorkspace(
  options: StartOptions,
  overrides: Partial<OrchestratorDeps> = {},
): Promise<StartResult> {
  const deps = { ...createDefaultDeps(), ...overrides };
  const emit = options.onEvent ?? (() => {});
  const workspaceDir = options.workspaceDir ?? ".";

  const existingState = await deps.readState(workspaceDir);
  if (existingState) {
    emit({ kind: "phase", phase: "Cleaning up previous workspace run" });
    const staleHandles = hydrateHandles(existingState);
    for (const handle of staleHandles) {
      await handle.stop();
    }
    await deps.composeDown({
      projectName: existingState.projectName,
      fileArgs: existingState.fileArgs,
      cwd: existingState.workspaceDir,
    });
    await deps.removeState(workspaceDir);
  }

  emit({ kind: "phase", phase: "Loading config" });
  let config = await deps.loadConfig(options.configPath);
  config = applyModeOverride(config, options.modeOverride);
  config = applyFilter(config, options.serviceFilter);

  emit({ kind: "phase", phase: "Building dependency graph" });
  const dag = deps.buildDag(config);
  const registry = deps.buildEndpointRegistry(config);

  emit({ kind: "phase", phase: "Loading plugins" });
  const context: PluginContext = {
    workspaceDir,
    workspaceName: config.name,
    logger: createLogger(emit),
  };
  const plugins = await deps.loadPlugins(config.plugins ?? {}, context);
  validatePluginTypes(config, plugins);

  emit({ kind: "phase", phase: "Collecting compose contributions" });
  const contributions = await collectContributions(config, plugins);

  emit({ kind: "phase", phase: "Generating compose and proxy config" });
  const composeResult = deps.generateCompose(config, contributions);
  await deps.writeComposeFile(composeResult.yaml, workspaceDir);

  const caddyResult = deps.generateCaddyfile(config);
  await deps.writeCaddyfile(caddyResult.content, workspaceDir);

  const hostsBlock = deps.generateHostsBlock(caddyResult.domains);
  if (hostsBlock) await deps.applyHosts(hostsBlock);

  checkAborted(options.signal);

  emit({ kind: "phase", phase: "Starting infrastructure" });
  const composeOptions = {
    projectName: composeResult.projectName,
    fileArgs: composeResult.fileArgs,
    cwd: workspaceDir,
  };
  await deps.composeUp(composeOptions);

  if (config.proxy?.tls?.enabled) {
    emit({ kind: "phase", phase: "Trusting Caddy CA" });
    await deps.trustCaddyCa(`${composeResult.projectName}-proxy`, workspaceDir);
  }

  const baseState = {
    workspaceName: config.name,
    projectName: composeResult.projectName,
    fileArgs: composeResult.fileArgs,
    workspaceDir,
    services: {} as Record<string, ServiceState>,
  };
  await deps.writeState(baseState, workspaceDir);

  checkAborted(options.signal);

  const hookCtx = {
    config,
    workspaceDir,
    pluginEnvVars: composeResult.pluginEnvVars,
    signal: options.signal,
    deps,
    emit,
  };

  await runWorkspaceHook({ hookName: "postInfrastructure", ...hookCtx });

  emit({ kind: "phase", phase: "Provisioning infrastructure" });
  await runPluginProvisioning(config, plugins, registry, workspaceDir);

  emit({ kind: "phase", phase: "Seeding data" });
  await runPluginSeeding(config, plugins, registry, workspaceDir);

  emit({ kind: "phase", phase: "Starting services" });
  const handles = await startServicesInLayers({
    layers: dag.layers,
    config,
    plugins,
    registry,
    pluginEnvVars: composeResult.pluginEnvVars,
    workspaceDir,
    signal: options.signal,
    deps,
    emit,
  });

  await deps.writeState({ ...baseState, services: buildServiceState(handles) }, workspaceDir);

  await runWorkspaceHook({ hookName: "postSetup", ...hookCtx });

  emit({ kind: "phase", phase: "Ready" });
  return { handles, composeOptions, config };
}

function applyModeOverride(config: WorkspaceConfig, mode?: "dev" | "container"): WorkspaceConfig {
  if (!mode) return config;

  const services: Record<string, (typeof config.services)[string]> = {};
  for (const [name, service] of Object.entries(config.services)) {
    services[name] = service.mode === "skip" ? service : { ...service, mode };
  }
  return { ...config, services };
}

function applyFilter(config: WorkspaceConfig, filter?: string[]): WorkspaceConfig {
  if (!filter || filter.length === 0) return config;

  const included = resolveServiceFilter(filter, config);
  const services: Record<string, (typeof config.services)[string]> = {};
  for (const [name, svc] of Object.entries(config.services)) {
    if (included.has(name)) services[name] = svc;
  }
  return { ...config, services };
}

function validatePluginTypes(config: WorkspaceConfig, plugins: Map<string, Plugin>): void {
  for (const [name, service] of Object.entries(config.services)) {
    if (!BUILTIN_TYPES.has(service.type) && !plugins.has(service.type)) {
      throw new OrchestratorError(
        `Service "${name}" has type "${service.type}" but no matching plugin is declared`,
      );
    }
  }
}

async function collectContributions(
  config: WorkspaceConfig,
  plugins: Map<string, Plugin>,
): Promise<ComposeContribution[]> {
  const contributions: ComposeContribution[] = [];

  for (const [typeName, plugin] of plugins) {
    if (!plugin.contributeCompose) continue;

    const pluginServices: Record<string, (typeof config.services)[string]> = {};
    for (const [name, svc] of Object.entries(config.services)) {
      if (svc.type === typeName) pluginServices[name] = svc;
    }

    if (Object.keys(pluginServices).length > 0) {
      const contribution = await plugin.contributeCompose({
        services: pluginServices,
        workspaceDir: config.name,
      });
      contributions.push(contribution);
    }
  }

  return contributions;
}

function buildServiceState(handles: ServiceHandle[]): Record<string, ServiceState> {
  const services: Record<string, ServiceState> = {};
  for (const h of handles) {
    services[h.serviceName] = {
      runner: h.type,
      ...(h.pid !== undefined && { pid: h.pid }),
      ...(h.containerId !== undefined && { containerId: h.containerId }),
    };
  }
  return services;
}

function buildEndpointMap(registry: EndpointRegistry): Record<string, string> {
  const endpoints: Record<string, string> = {};
  for (const [name, ep] of registry.endpoints) {
    endpoints[name] = ep.internalUrl;
  }
  return endpoints;
}

async function runWorkspaceHook(ctx: WorkspaceHookContext): Promise<void> {
  const command = ctx.config.hooks?.[ctx.hookName];
  if (!command) return;

  ctx.emit({ kind: "phase", phase: `Running ${ctx.hookName} hook` });
  await ctx.deps.executeHook(`workspace:${ctx.hookName}`, command, {
    cwd: ctx.workspaceDir,
    env: ctx.pluginEnvVars,
    signal: ctx.signal,
    onOutput: (output) => ctx.emit({ kind: "hook", hook: ctx.hookName, output }),
  });
}

async function runPluginProvisioning(
  config: WorkspaceConfig,
  plugins: Map<string, Plugin>,
  registry: EndpointRegistry,
  workspaceDir: string,
): Promise<void> {
  const endpoints = buildEndpointMap(registry);
  const promises: Promise<unknown>[] = [];

  for (const [name, service] of Object.entries(config.services)) {
    const plugin = plugins.get(service.type);
    if (!plugin?.provisionInfra) continue;

    promises.push(
      plugin.provisionInfra({
        serviceName: name,
        servicePath: `${workspaceDir}/${service.path}`,
        endpoints,
      }),
    );
  }

  await Promise.all(promises);
}

async function runPluginSeeding(
  config: WorkspaceConfig,
  plugins: Map<string, Plugin>,
  registry: EndpointRegistry,
  workspaceDir: string,
): Promise<void> {
  const endpoints = buildEndpointMap(registry);
  const promises: Promise<unknown>[] = [];

  for (const [name, service] of Object.entries(config.services)) {
    const plugin = plugins.get(service.type);
    if (!plugin?.seedData) continue;

    promises.push(
      plugin.seedData({
        serviceName: name,
        servicePath: `${workspaceDir}/${service.path}`,
        mode: "run",
        endpoints,
      }),
    );
  }

  await Promise.all(promises);
}

async function startServicesInLayers(ctx: LayerStartContext): Promise<ServiceHandle[]> {
  const allHandles: ServiceHandle[] = [];

  try {
    for (const layer of ctx.layers) {
      checkAborted(ctx.signal);

      const layerPromises = layer
        .filter((name) => ctx.config.services[name].mode !== "skip")
        .map(async (name) => {
          ctx.emit({ kind: "service", service: name, status: "starting" });
          const handle = await ctx.deps.startService({
            serviceName: name,
            serviceConfig: ctx.config.services[name],
            config: ctx.config,
            plugin: ctx.plugins.get(ctx.config.services[name].type),
            registry: ctx.registry,
            pluginEnvVars: ctx.pluginEnvVars,
            workspaceDir: ctx.workspaceDir,
            signal: ctx.signal,
            onOutput: (line) => ctx.emit({ kind: "output", line }),
            onHookOutput: (output) => ctx.emit({ kind: "hook", hook: name, output }),
          });
          ctx.emit({ kind: "service", service: name, status: "started" });
          return handle;
        });

      const results = await Promise.allSettled(layerPromises);
      for (const result of results) {
        if (result.status === "fulfilled") allHandles.push(result.value);
      }

      const firstFailure = results.find((r) => r.status === "rejected");
      if (firstFailure) {
        throw (firstFailure as PromiseRejectedResult).reason;
      }
    }
  } catch (err) {
    for (const handle of allHandles) {
      try {
        await handle.stop();
      } catch {
        // Best-effort cleanup
      }
    }
    throw err;
  }

  return allHandles;
}

function createLogger(emit: (event: OrchestratorEvent) => void) {
  return {
    info: (msg: string) => emit({ kind: "phase", phase: msg }),
    warn: (msg: string) => emit({ kind: "error", message: msg }),
    error: (msg: string) => emit({ kind: "error", message: msg }),
    debug: () => {},
  };
}
