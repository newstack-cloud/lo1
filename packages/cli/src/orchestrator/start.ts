import { join } from "node:path";
import type { Plugin, PluginContext, WorkspaceConfig, ComposeContribution } from "@lo1/sdk";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("orchestrator");
import { createLineBuffer } from "../output/line-buffer";
import type { EndpointRegistry } from "../discovery/registry";
import { loadWorkspaceConfig } from "../config/loader";
import { buildDag } from "../dag/index";
import { buildEndpointRegistry } from "../discovery/registry";
import {
  generateCompose,
  writeComposeFile,
  preprocessServiceComposeFiles,
  discoverExtraComposeServices,
  extraComposeFile,
  extraComposeInitTasks,
  networkId,
} from "../compose/generate";
import { generateCaddyfile, writeCaddyfile, type CaddyfileResult } from "../proxy/caddyfile";
import { generateHostsBlock, applyHosts } from "../hosts/index";
import { composeUp, composeWait, composeLogs, type ComposeLogLine } from "../runner/compose";
import { loadPlugins } from "../plugin/loader";
import { executeHook } from "../hooks/executor";
import { trustCaddyCa as defaultTrustCaddyCa } from "../tls/setup";
import { getAcmeConfig, verifyAcmeEnv, writeProxyDockerfile } from "../tls/acme";
import { startService as defaultStartService, BUILTIN_TYPES } from "./service";
import { writeState as defaultWriteState } from "./state";
import { resolveServiceFilter } from "./filter";
import { hydrateHandles } from "./stop";
import { findPortConflicts, PortConflictError } from "../doctor/ports";
import type {
  OrchestratorDeps,
  StartOptions,
  StartResult,
  StartTimings,
  PhaseTiming,
  OrchestratorEvent,
  ServiceState,
} from "./types";
import type { ComposeContext, ServiceHandle } from "./service";

export class OrchestratorError extends Lo1Error {
  constructor(message: string) {
    super(message, "OrchestratorError");
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
  compose: ComposeContext;
  detached: boolean;
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
    writeProxyDockerfile: (config, workspaceDir) =>
      writeProxyDockerfile(getAcmeConfig(config), workspaceDir),
    generateHostsBlock,
    applyHosts,
    removeHosts: () => import("../hosts/index").then((m) => m.removeHosts()),
    composeUp,
    composeWait,
    composeLogs,
    discoverExtraComposeServices,
    composeDown: (opts) => import("../runner/compose").then((m) => m.composeDown(opts)),
    ensureNetwork: (project, key) =>
      import("../runner/compose").then((m) => m.ensureComposeNetwork(project, key)),
    composePs: (opts) => import("../runner/compose").then((m) => m.composePs(opts)),
    startService: defaultStartService,
    executeHook,
    trustCaddyCa: defaultTrustCaddyCa,
    readState: (dir) => import("./state").then((m) => m.readState(dir)),
    writeState: defaultWriteState,
    removeState: (dir) => import("./state").then((m) => m.removeState(dir)),
    findPortConflicts: (config) => findPortConflicts(config),
  };
}

type PrepareResult = {
  config: WorkspaceConfig;
  dag: { layers: string[][] };
  registry: EndpointRegistry;
  plugins: Map<string, Plugin>;
  composeResult: ReturnType<OrchestratorDeps["generateCompose"]>;
  infraInitTasks: string[];
  caddyResult: CaddyfileResult;
};

export async function startWorkspace(
  options: StartOptions,
  overrides: Partial<OrchestratorDeps> = {},
): Promise<StartResult> {
  debug("startWorkspace: dir=%s", options.workspaceDir ?? ".");
  const deps = { ...createDefaultDeps(), ...overrides };
  const emit = options.onEvent ?? (() => {});
  const workspaceDir = options.workspaceDir ?? ".";
  const timer = createPhaseTimer();

  await cleanupStaleWorkspace(deps, workspaceDir, emit);

  const prepared = await prepareWorkspaceConfig(deps, options, workspaceDir, emit);
  const { config, dag, registry, plugins, composeResult, infraInitTasks, caddyResult } = prepared;

  checkAborted(options.signal);

  // Write state early so teardown can find the compose project on failure.
  const baseState = {
    workspaceName: config.name,
    projectName: composeResult.projectName,
    fileArgs: composeResult.fileArgs,
    workspaceDir,
    services: {} as Record<string, ServiceState>,
    pluginEnvVars: composeResult.pluginEnvVars,
    ...(options.modeOverride && { modeOverride: options.modeOverride }),
    infraServices: composeResult.infraServices,
    infraInitTasks,
  };
  await deps.writeState({ ...baseState, ready: false }, workspaceDir);

  debug("startWorkspace: starting compose phases");
  const infraLogs = await startInfrastructure(
    deps,
    composeResult,
    infraInitTasks,
    workspaceDir,
    options,
    emit,
  );

  // With no infrastructure, nothing has created the network plugin containers join.
  if (composeResult.infraServices.length === 0) {
    await deps.ensureNetwork(composeResult.projectName, networkId(config.name));
  }

  if (config.proxy?.tls?.enabled && caddyResult.internalDomains.length > 0) {
    debug("startWorkspace: trusting Caddy CA for %d domain(s)", caddyResult.internalDomains.length);
    emit({ kind: "phase", phase: "Trusting Caddy CA" });
    await deps.trustCaddyCa(`${composeResult.projectName}-proxy`, workspaceDir);
  }
  timer.mark("infrastructure", infraLogs !== undefined);

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

  debug("startWorkspace: provisioning infrastructure");
  emit({ kind: "phase", phase: "Provisioning infrastructure" });
  await runPluginProvisioning(config, plugins, registry, workspaceDir);

  debug("startWorkspace: seeding data");
  emit({ kind: "phase", phase: "Seeding data" });
  await runPluginSeeding(config, plugins, registry, workspaceDir);
  timer.mark("setup", hasSetupWork(config, plugins));

  debug("startWorkspace: starting services");
  emit({ kind: "phase", phase: "Starting services" });
  const composeContext: ComposeContext = {
    projectName: composeResult.projectName,
    fileArgs: composeResult.fileArgs,
    cwd: workspaceDir,
  };
  const handles = await startServicesInLayers({
    layers: dag.layers,
    config,
    plugins,
    registry,
    pluginEnvVars: composeResult.pluginEnvVars,
    workspaceDir,
    compose: composeContext,
    detached: options.detached === true,
    signal: options.signal,
    deps,
    emit,
  });

  await deps.writeState(
    { ...baseState, services: buildServiceState(handles), ready: true },
    workspaceDir,
  );
  await runWorkspaceHook({ hookName: "postSetup", ...hookCtx });
  timer.mark("services", true);

  emit({ kind: "phase", phase: "Ready" });
  const composeOptions = {
    projectName: composeResult.projectName,
    fileArgs: composeResult.fileArgs,
    cwd: workspaceDir,
  };
  const logsHandle = {
    kill: () => {
      infraLogs?.kill();
      for (const handle of handles) handle.releaseLogs?.();
    },
  };
  return {
    handles,
    composeOptions,
    config,
    logsHandle,
    plugins,
    registry,
    pluginEnvVars: composeResult.pluginEnvVars,
    compose: composeContext,
    timings: timer.result(),
  };
}

/** Measures consecutive startup phases; `mark` closes the phase that just ran. */
function createPhaseTimer() {
  const startedAt = Date.now();
  let phaseStart = startedAt;
  const phases: PhaseTiming[] = [];
  return {
    mark(name: string, include: boolean) {
      const now = Date.now();
      if (include) phases.push({ name, ms: now - phaseStart });
      phaseStart = now;
    },
    result: (): StartTimings => ({ totalMs: Date.now() - startedAt, phases }),
  };
}

/** Whether anything runs between infrastructure and services worth timing on its own. */
function hasSetupWork(config: WorkspaceConfig, plugins: Map<string, Plugin>): boolean {
  if (config.hooks?.postInfrastructure) return true;
  return Object.values(config.services).some((service) => {
    const plugin = plugins.get(service.type);
    return Boolean(plugin?.provisionInfra || plugin?.seedData);
  });
}

async function cleanupStaleWorkspace(
  deps: OrchestratorDeps,
  workspaceDir: string,
  emit: (event: OrchestratorEvent) => void,
): Promise<void> {
  const existingState = await deps.readState(workspaceDir);
  if (!existingState) return;

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

async function prepareWorkspaceConfig(
  deps: OrchestratorDeps,
  options: StartOptions,
  workspaceDir: string,
  emit: (event: OrchestratorEvent) => void,
): Promise<PrepareResult> {
  emit({ kind: "phase", phase: "Loading config" });
  let config = await deps.loadConfig(options.configPath);
  config = applyModeOverride(config, options.modeOverride);
  config = applyFilter(config, options.serviceFilter);

  const conflicts = await deps.findPortConflicts(config);
  if (conflicts.length > 0) throw new PortConflictError(conflicts);

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
  await prepareTls(deps, config, workspaceDir);
  const composeResult = deps.generateCompose(config, contributions);
  await deps.writeComposeFile(composeResult.yaml, workspaceDir);
  await preprocessServiceComposeFiles(config, workspaceDir, composeResult.pluginEnvVars);

  const ecFile = extraComposeFile(config);
  const infraInitTasks = extraComposeInitTasks(config);
  if (ecFile) {
    const extraServices = await deps.discoverExtraComposeServices(ecFile, workspaceDir);
    composeResult.infraServices.push(...extraServices);
  }

  const caddyResult = deps.generateCaddyfile(config);
  await deps.writeCaddyfile(caddyResult.content, workspaceDir);

  const hostsBlock = deps.generateHostsBlock(caddyResult.domains);
  if (hostsBlock) await deps.applyHosts(hostsBlock);

  return { config, dag, registry, plugins, composeResult, infraInitTasks, caddyResult };
}

/**
 * Validates TLS prerequisites and writes the proxy Dockerfile before anything
 * is generated, so a missing DNS credential fails before containers start.
 */
async function prepareTls(
  deps: OrchestratorDeps,
  config: WorkspaceConfig,
  workspaceDir: string,
): Promise<void> {
  const acme = getAcmeConfig(config);
  if (!acme) return;

  verifyAcmeEnv(acme);
  await deps.writeProxyDockerfile(config, workspaceDir);
}

/**
 * Starts the infrastructure layer: plugin contributions, the proxy and the
 * extraCompose services. lo1 services that run through compose are started
 * later, in their dependency layer.
 */
async function startInfrastructure(
  deps: OrchestratorDeps,
  composeResult: PrepareResult["composeResult"],
  infraInitTasks: string[],
  workspaceDir: string,
  options: StartOptions,
  emit: (event: OrchestratorEvent) => void,
): Promise<{ kill: () => void } | undefined> {
  const emitInfraLine = (stream: "stdout" | "stderr") => (text: string) =>
    emit({
      kind: "output",
      line: { service: "infrastructure", stream, text, timestamp: new Date() },
    });

  const stdoutBuffer = createLineBuffer(emitInfraLine("stdout"));
  const stderrBuffer = createLineBuffer(emitInfraLine("stderr"));

  const composeOptions = {
    projectName: composeResult.projectName,
    fileArgs: composeResult.fileArgs,
    cwd: workspaceDir,
    signal: options.signal,
    onOutput: (chunk: { stream: "stdout" | "stderr"; text: string }) => {
      (chunk.stream === "stdout" ? stdoutBuffer : stderrBuffer)(chunk.text);
    },
  };

  const emitLogLine = (line: ComposeLogLine) =>
    emit({
      kind: "output",
      line: { service: line.service, stream: line.stream, text: line.text, timestamp: new Date() },
    });

  const infraServices = composeResult.infraServices;
  if (infraServices.length === 0) return undefined;

  emit({ kind: "phase", phase: "Starting infrastructure" });
  await deps.composeUp({ ...composeOptions, services: infraServices });
  const logsHandle = deps.composeLogs({ ...composeOptions, services: infraServices }, emitLogLine);

  try {
    await deps.composeWait({
      projectName: composeResult.projectName,
      fileArgs: composeResult.fileArgs,
      services: infraServices,
      cwd: workspaceDir,
      signal: options.signal,
      waitForExit: infraInitTasks,
    });
  } catch (err) {
    logsHandle.kill();
    throw err;
  }

  return logsHandle;
}

export function applyModeOverride(
  config: WorkspaceConfig,
  mode?: "dev" | "container",
): WorkspaceConfig {
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

export function buildServiceState(handles: ServiceHandle[]): Record<string, ServiceState> {
  const services: Record<string, ServiceState> = {};
  for (const h of handles) {
    // A finished init task has nothing left to stop, and its pid may be reused.
    if (h.type === "process" && !h.running) continue;
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
        servicePath: join(workspaceDir, service.path),
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
        servicePath: join(workspaceDir, service.path),
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
    for (let i = 0; i < ctx.layers.length; i++) {
      const layer = ctx.layers[i];
      debug(
        "startServicesInLayers: layer %d/%d, %d services",
        i + 1,
        ctx.layers.length,
        layer.length,
      );
      checkAborted(ctx.signal);

      const layerPromises = layer
        .filter((name) => ctx.config.services[name].mode !== "skip")
        .map(async (name) => {
          const serviceConfig = ctx.config.services[name];
          ctx.emit({ kind: "service", service: name, status: "starting" });
          const handle = await ctx.deps.startService({
            serviceName: name,
            serviceConfig,
            config: ctx.config,
            plugin: ctx.plugins.get(serviceConfig.type),
            registry: ctx.registry,
            pluginEnvVars: ctx.pluginEnvVars,
            workspaceDir: ctx.workspaceDir,
            compose: ctx.compose,
            detached: ctx.detached,
            signal: ctx.signal,
            onOutput: (line) => ctx.emit({ kind: "output", line }),
            onHookOutput: (output) => ctx.emit({ kind: "hook", hook: name, output }),
          });
          const status = serviceConfig.initTask ? "completed" : "started";
          ctx.emit({ kind: "service", service: name, status });
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

export function createLogger(emit: (event: OrchestratorEvent) => void) {
  return {
    info: (msg: string) => emit({ kind: "phase", phase: msg }),
    warn: (msg: string) => emit({ kind: "error", message: msg }),
    error: (msg: string) => emit({ kind: "error", message: msg }),
    debug: () => {},
  };
}
