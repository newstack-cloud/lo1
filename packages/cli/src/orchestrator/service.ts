import { resolve } from "node:path";
import type { Plugin, WorkspaceConfig, ServiceConfig, ContainerInput } from "@lo1/sdk";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";
import type { EndpointRegistry } from "../discovery/registry";
import type { OutputLine } from "../runner/process";
import type { HookOutput } from "../hooks/executor";
import { startProcess as defaultStartProcess } from "../runner/process";
import { startContainer as defaultStartContainer } from "../runner/container";
import {
  composeUp as defaultComposeUp,
  composeWait as defaultComposeWait,
  composeLogs as defaultComposeLogs,
} from "../runner/compose";
import { executeHook as defaultExecuteHook } from "../hooks/executor";
import {
  buildServiceEnv as defaultBuildServiceEnv,
  containerFacingUrl,
} from "../discovery/registry";
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
  /** Stops following the service's output without stopping the service itself. */
  releaseLogs?(): void;
};

/** The workspace's compose project, used to start compose-run services in their layer. */
export type ComposeContext = {
  projectName: string;
  fileArgs: string[];
  cwd: string;
};

export type StartServiceOptions = {
  serviceName: string;
  serviceConfig: ServiceConfig;
  config: WorkspaceConfig;
  plugin: Plugin | undefined;
  registry: EndpointRegistry;
  pluginEnvVars: Record<string, string>;
  workspaceDir: string;
  compose?: ComposeContext;
  signal?: AbortSignal;
  onOutput?: (line: OutputLine) => void;
  onHookOutput?: (output: HookOutput) => void;
};

export type StartServiceDeps = {
  startProcess: typeof defaultStartProcess;
  startContainer: typeof defaultStartContainer;
  composeUp: typeof defaultComposeUp;
  composeWait: typeof defaultComposeWait;
  composeLogs: typeof defaultComposeLogs;
  executeHook: typeof defaultExecuteHook;
  buildServiceEnv: typeof defaultBuildServiceEnv;
  waitForReady: typeof defaultWaitForReady;
};

const defaultDeps: StartServiceDeps = {
  startProcess: defaultStartProcess,
  startContainer: defaultStartContainer,
  composeUp: defaultComposeUp,
  composeWait: defaultComposeWait,
  composeLogs: defaultComposeLogs,
  executeHook: defaultExecuteHook,
  buildServiceEnv: defaultBuildServiceEnv,
  waitForReady: defaultWaitForReady,
};

export const BUILTIN_TYPES = new Set(["service", "app"]);

type Runner = "plugin-container" | "process" | "compose";

/** A started service, plus the exit of its process when lo1 runs it on the host. */
type StartedRunner = {
  handle: ServiceHandle;
  exited?: Promise<number | null>;
};

export async function startService(
  options: StartServiceOptions,
  deps: StartServiceDeps = defaultDeps,
): Promise<ServiceHandle> {
  const { serviceName, serviceConfig } = options;
  const runner = selectRunner(options);
  debug("startService: name=%s mode=%s runner=%s", serviceName, serviceConfig.mode, runner);

  const env = deps.buildServiceEnv(
    serviceName,
    serviceConfig,
    options.config,
    options.registry,
    options.pluginEnvVars,
    runner === "process" ? "host" : "container",
  );

  const hookCwd = resolve(options.workspaceDir, serviceConfig.path);
  const runHook = (command: string | undefined, hookName: string) =>
    runHookIfDefined({ command, hookName, cwd: hookCwd, env, options, deps });

  await runHook(serviceConfig.hooks?.preStart, `${serviceName}:preStart`);

  const started = await startRunner(runner, options, env, deps);

  if (serviceConfig.initTask) {
    await waitForInitTask(started, options);
  } else {
    await waitForReadiness(started.handle, options, deps);
  }

  await runHook(serviceConfig.hooks?.postStart, `${serviceName}:postStart`);
  return started.handle;
}

function selectRunner(options: StartServiceOptions): Runner {
  const { serviceName, serviceConfig, plugin } = options;
  if (plugin?.configureContainer !== undefined) return "plugin-container";

  const isBuiltin = BUILTIN_TYPES.has(serviceConfig.type);
  if (isBuiltin && serviceConfig.mode === "dev") return "process";

  const hasContainerSource = Boolean(serviceConfig.containerImage || serviceConfig.compose);
  if (serviceConfig.mode === "container" && hasContainerSource) return "compose";

  throw new ServiceStartError(
    `Service "${serviceName}" (type: ${serviceConfig.type}, mode: ${serviceConfig.mode}) ` +
      `has no valid runner: needs a plugin with configureContainer(), a command for dev mode, ` +
      `or a containerImage/compose file for container mode`,
  );
}

async function startRunner(
  runner: Runner,
  options: StartServiceOptions,
  env: Record<string, string>,
  deps: StartServiceDeps,
): Promise<StartedRunner> {
  if (runner === "plugin-container") {
    return { handle: await startWithContainer(options, env, deps) };
  }
  if (runner === "process") return startWithProcess(options, env, deps);
  return { handle: await startWithCompose(options, deps) };
}

/**
 * An init task (a migration, a seed script) counts as started once it has
 * exited successfully, so services in later layers see its results.
 * Compose-run init tasks are waited on by composeWait instead.
 */
async function waitForInitTask(started: StartedRunner, options: StartServiceOptions) {
  if (!started.exited) return;

  const code = await raceAbort(started.exited, options.signal);
  if (code === "aborted") {
    await started.handle.stop();
    throw new ServiceStartError("Startup aborted");
  }
  if (code !== 0) {
    const reason = code === null ? "failed to run" : `exited with code ${code}`;
    throw new ServiceStartError(`Init task "${options.serviceName}" ${reason}`);
  }
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | "aborted"> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve("aborted");

  return new Promise((resolvePromise, reject) => {
    const onAbort = () => resolvePromise("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function waitForReadiness(
  handle: ServiceHandle,
  options: StartServiceOptions,
  deps: StartServiceDeps,
): Promise<void> {
  const url = options.serviceConfig.readinessProbe;
  if (!url) return;

  try {
    await deps.waitForReady({ url, serviceName: options.serviceName, signal: options.signal });
  } catch (err) {
    await handle.stop();
    throw err;
  }
}

type HookRun = {
  command: string | undefined;
  hookName: string;
  cwd: string;
  env: Record<string, string>;
  options: StartServiceOptions;
  deps: StartServiceDeps;
};

async function runHookIfDefined(run: HookRun): Promise<void> {
  if (!run.command) return;
  await run.deps.executeHook(run.hookName, run.command, {
    cwd: run.cwd,
    env: run.env,
    signal: run.options.signal,
    onOutput: run.options.onHookOutput,
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
    endpoints[name] = containerFacingUrl(ep);
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
  // The registry advertises this service at its host port, as for a host
  // process, so the container must publish it there.
  const own = registry.endpoints.get(serviceName);
  const handle = await deps.startContainer({
    workspaceName: config.name,
    serviceName,
    containerConfig,
    networkName: `${projectId(config.name)}_${networkId(config.name)}`,
    env,
    ports: own ? [`${own.hostPort}:${own.port}`] : [],
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
): StartedRunner {
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
    handle: {
      serviceName,
      type: "process",
      pid: handle.pid,
      get running() {
        return handle.running;
      },
      stop: async (timeout) => {
        await handle.stop(timeout);
      },
    },
    exited: handle.exitPromise,
  };
}

/**
 * Starts a containerImage or compose-file service on its own, in its
 * dependency layer, and waits until it is running (healthy, if it has a
 * healthcheck) or, for an init task, until it has exited with code 0.
 */
async function startWithCompose(
  options: StartServiceOptions,
  deps: StartServiceDeps,
): Promise<ServiceHandle> {
  const { serviceName, serviceConfig, compose, signal } = options;
  if (!compose) {
    throw new ServiceStartError(
      `Service "${serviceName}" runs through Docker Compose, but no compose project was given`,
    );
  }

  const services = [serviceName];
  await deps.composeUp({ ...compose, services, signal });

  const logs = deps.composeLogs({ ...compose, services }, (line) =>
    options.onOutput?.({
      service: line.service,
      stream: line.stream,
      text: line.text,
      timestamp: new Date(),
    }),
  );

  try {
    await deps.composeWait({
      ...compose,
      services,
      signal,
      waitForExit: serviceConfig.initTask ? services : [],
    });
  } catch (err) {
    logs.kill();
    throw err;
  }

  return {
    serviceName,
    type: "compose",
    running: true,
    // Compose services are stopped by composeDown along with the infrastructure.
    stop: async () => logs.kill(),
    releaseLogs: () => logs.kill(),
  };
}
