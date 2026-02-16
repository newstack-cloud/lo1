import { resolve } from "node:path";
import type { Plugin, WorkspaceConfig, ServiceConfig, ContainerInput } from "@lo1/sdk";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";
import type { EndpointRegistry } from "../discovery/registry";
import type { OutputLine } from "../runner/process";
import type { HookOutput } from "../hooks/executor";
import { startProcess as defaultStartProcess } from "../runner/process";
import { startContainer as defaultStartContainer } from "../runner/container";
import { executeHook as defaultExecuteHook } from "../hooks/executor";
import { buildServiceEnv as defaultBuildServiceEnv } from "../discovery/registry";
import { waitForReady as defaultWaitForReady } from "../readiness/probe";
import { projectId, networkId } from "../compose/generate";

const debug = createLog("orchestrator");

export class ServiceStartError extends Lo1Error {
  constructor(message: string) {
    super(message, "ServiceStartError");
    this.name = "ServiceStartError";
  }
}

export type ServiceHandle = {
  serviceName: string;
  type: "process" | "container" | "compose";
  pid?: number;
  containerId?: string;
  running: boolean;
  stop(timeoutMs?: number): Promise<void>;
};

export type StartServiceOptions = {
  serviceName: string;
  serviceConfig: ServiceConfig;
  config: WorkspaceConfig;
  plugin: Plugin | undefined;
  registry: EndpointRegistry;
  pluginEnvVars: Record<string, string>;
  workspaceDir: string;
  signal?: AbortSignal;
  onOutput?: (line: OutputLine) => void;
  onHookOutput?: (output: HookOutput) => void;
};

export type StartServiceDeps = {
  startProcess: typeof defaultStartProcess;
  startContainer: typeof defaultStartContainer;
  executeHook: typeof defaultExecuteHook;
  buildServiceEnv: typeof defaultBuildServiceEnv;
  waitForReady: typeof defaultWaitForReady;
};

const defaultDeps: StartServiceDeps = {
  startProcess: defaultStartProcess,
  startContainer: defaultStartContainer,
  executeHook: defaultExecuteHook,
  buildServiceEnv: defaultBuildServiceEnv,
  waitForReady: defaultWaitForReady,
};

export const BUILTIN_TYPES = new Set(["service", "app"]);

export async function startService(
  options: StartServiceOptions,
  deps: StartServiceDeps = defaultDeps,
): Promise<ServiceHandle> {
  const { serviceName, serviceConfig, plugin } = options;
  const hasPluginContainer = plugin?.configureContainer !== undefined;
  const isBuiltin = BUILTIN_TYPES.has(serviceConfig.type);
  const consumerMode = determineConsumerMode(serviceConfig, hasPluginContainer);
  const runner = hasPluginContainer
    ? "container (plugin)"
    : isBuiltin && serviceConfig.mode === "dev"
      ? "process"
      : "compose";
  debug("startService: name=%s mode=%s runner=%s", serviceName, serviceConfig.mode, runner);

  const env = deps.buildServiceEnv(
    serviceName,
    serviceConfig,
    options.config,
    options.registry,
    options.pluginEnvVars,
    consumerMode,
  );

  const hookCwd = resolve(options.workspaceDir, serviceConfig.path);
  await runHookIfDefined(
    serviceConfig.hooks?.preStart,
    `${serviceName}:preStart`,
    hookCwd,
    env,
    options,
    deps,
  );

  let handle: ServiceHandle;
  if (hasPluginContainer) {
    handle = await startWithContainer(options, env, deps);
  } else if (serviceConfig.mode === "dev" && isBuiltin) {
    handle = startWithProcess(options, env, deps);
  } else if (
    serviceConfig.mode === "container" &&
    (serviceConfig.containerImage || serviceConfig.compose)
  ) {
    handle = createComposeHandle(serviceName);
  } else {
    throw new ServiceStartError(
      `Service "${serviceName}" (type: ${serviceConfig.type}, mode: ${serviceConfig.mode}) ` +
        `has no valid runner: needs a plugin with configureContainer(), a command for dev mode, ` +
        `or a containerImage/compose file for container mode`,
    );
  }

  if (serviceConfig.readinessProbe) {
    try {
      await deps.waitForReady({
        url: serviceConfig.readinessProbe,
        serviceName,
        signal: options.signal,
      });
    } catch (err) {
      await handle.stop();
      throw err;
    }
  }

  await runHookIfDefined(
    serviceConfig.hooks?.postStart,
    `${serviceName}:postStart`,
    hookCwd,
    env,
    options,
    deps,
  );
  return handle;
}

function determineConsumerMode(
  serviceConfig: ServiceConfig,
  hasPluginContainer: boolean,
): "container" | "host" {
  if (hasPluginContainer) return "container";
  if (serviceConfig.mode === "container") return "container";
  return "host";
}

async function runHookIfDefined(
  command: string | undefined,
  hookName: string,
  cwd: string,
  env: Record<string, string>,
  options: StartServiceOptions,
  deps: StartServiceDeps,
): Promise<void> {
  if (!command) return;
  await deps.executeHook(hookName, command, {
    cwd,
    env,
    signal: options.signal,
    onOutput: options.onHookOutput,
  });
}

async function startWithContainer(
  options: StartServiceOptions,
  env: Record<string, string>,
  deps: StartServiceDeps,
): Promise<ServiceHandle> {
  const { serviceName, serviceConfig, plugin, config, registry } = options;

  const endpoints: Record<string, string> = {};
  for (const [name, ep] of registry.endpoints) {
    endpoints[name] = ep.internalUrl;
  }

  const input: ContainerInput = {
    serviceName,
    servicePath: resolve(options.workspaceDir, serviceConfig.path),
    servicePort: String(serviceConfig.port ?? ""),
    mode: serviceConfig.mode === "skip" ? "dev" : serviceConfig.mode,
    networkName: `${projectId(config.name)}_${networkId(config.name)}`,
    endpoints,
  };

  const containerConfig = await plugin!.configureContainer!(input);
  const handle = await deps.startContainer({
    workspaceName: config.name,
    serviceName,
    containerConfig,
    networkName: `${projectId(config.name)}_${networkId(config.name)}`,
    env,
    onOutput: options.onOutput,
  });

  return {
    serviceName,
    type: "container",
    containerId: handle.containerId,
    get running() {
      return handle.running;
    },
    stop: (timeout) => handle.stop(timeout),
  };
}

function startWithProcess(
  options: StartServiceOptions,
  env: Record<string, string>,
  deps: StartServiceDeps,
): ServiceHandle {
  const { serviceName, serviceConfig } = options;

  if (!serviceConfig.command) {
    throw new ServiceStartError(`Service "${serviceName}" is in dev mode but has no command`);
  }

  const handle = deps.startProcess({
    serviceName,
    command: serviceConfig.command,
    cwd: resolve(options.workspaceDir, serviceConfig.path),
    env,
    onOutput: options.onOutput,
  });

  return {
    serviceName,
    type: "process",
    pid: handle.pid,
    get running() {
      return handle.running;
    },
    stop: async (timeout) => {
      await handle.stop(timeout);
    },
  };
}

function createComposeHandle(serviceName: string): ServiceHandle {
  return {
    serviceName,
    type: "compose",
    running: true,
    stop: async () => {
      // Compose services are managed by composeDown, not individually
    },
  };
}
