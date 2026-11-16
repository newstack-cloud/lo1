import type { Plugin, PluginContext, WorkspaceConfig, ComposeContribution } from "@lo1/sdk";
import type { EndpointRegistry } from "../discovery/registry";
import type { DagResult } from "../dag/index";
import type { ComposeResult } from "../compose/generate";
import type { CaddyfileResult } from "../proxy/caddyfile";
import type { OutputLine } from "../runner/process";
import type { HookOutput, HookResult } from "../hooks/executor";
import type {
  ComposeExecOptions,
  ComposeWaitOptions,
  ComposeServiceStatus,
  ComposeLogLine,
  ComposeLogsHandle,
} from "../runner/compose";
import type { ComposeContext, ServiceHandle, StartServiceOptions } from "./service";
import type { PortClaim } from "../doctor/ports";

export type ServiceStatus = "starting" | "started" | "completed" | "stopping" | "stopped";

export type OrchestratorEvent =
  | { kind: "phase"; phase: string }
  | { kind: "service"; service: string; status: ServiceStatus }
  | { kind: "hook"; hook: string; output: HookOutput }
  | { kind: "output"; line: OutputLine }
  | { kind: "probe"; service: string; status: "polling" | "ready" | "failed"; attempt?: number }
  | { kind: "error"; message: string };

export type OrchestratorDeps = {
  loadConfig: (configPath?: string) => Promise<WorkspaceConfig>;
  loadPlugins: (
    declarations: Record<string, string>,
    context: PluginContext,
  ) => Promise<Map<string, Plugin>>;
  buildDag: (config: WorkspaceConfig) => DagResult;
  buildEndpointRegistry: (config: WorkspaceConfig) => EndpointRegistry;
  generateCompose: (
    config: WorkspaceConfig,
    contributions?: ComposeContribution[],
  ) => ComposeResult;
  writeComposeFile: (yaml: string, workspaceDir?: string) => Promise<string>;
  generateCaddyfile: (config: WorkspaceConfig) => CaddyfileResult;
  writeProxyDockerfile: (config: WorkspaceConfig, workspaceDir?: string) => Promise<string | null>;
  writeCaddyfile: (content: string, workspaceDir?: string) => Promise<string>;
  generateHostsBlock: (domains: string[]) => string;
  applyHosts: (block: string) => Promise<void>;
  removeHosts: () => Promise<void>;
  composeUp: (options: ComposeExecOptions) => Promise<void>;
  composeWait: (options: ComposeWaitOptions) => Promise<void>;
  composeLogs: (
    options: ComposeExecOptions,
    onLog: (line: ComposeLogLine) => void,
  ) => ComposeLogsHandle;
  discoverExtraComposeServices: (path: string, workspaceDir?: string) => Promise<string[]>;
  composeDown: (options: ComposeExecOptions & { clean?: boolean }) => Promise<void>;
  composePs: (options: ComposeExecOptions) => Promise<ComposeServiceStatus[]>;
  startService: (options: StartServiceOptions) => Promise<ServiceHandle>;
  executeHook: (
    hookName: string,
    command: string,
    options: {
      cwd: string;
      env: Record<string, string>;
      signal?: AbortSignal;
      onOutput?: (output: HookOutput) => void;
    },
  ) => Promise<HookResult>;
  trustCaddyCa: (containerName: string, workspaceDir: string) => Promise<void>;
  readState: (workspaceDir?: string) => Promise<WorkspaceState | null>;
  writeState: (state: WorkspaceState, workspaceDir?: string) => Promise<void>;
  removeState: (workspaceDir?: string) => Promise<void>;
  /** Returns the ports the workspace needs that something else is already using. */
  findPortConflicts: (config: WorkspaceConfig) => Promise<PortClaim[]>;
};

export type StartOptions = {
  configPath?: string;
  workspaceDir?: string;
  serviceFilter?: string[];
  modeOverride?: "dev" | "container";
  /** Start host processes so they keep running after lo1 exits. */
  detached?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: OrchestratorEvent) => void;
};

export type PhaseTiming = { name: string; ms: number };

/**
 * How long `lo1 up` took. Phases are "infrastructure" (when there is any),
 * "setup" (postInfrastructure hook and plugin provisioning/seeding, when
 * there are any) and "services" (every layer, init tasks included).
 */
export type StartTimings = { totalMs: number; phases: PhaseTiming[] };

export type StartResult = {
  handles: ServiceHandle[];
  composeOptions: ComposeExecOptions;
  config: WorkspaceConfig;
  /** Handle for the long-running `docker compose logs -f` process.
   *  Caller should kill it during shutdown. */
  logsHandle: { kill: () => void };
  /** What a later restart of a service needs to start it the same way. */
  plugins: Map<string, Plugin>;
  registry: EndpointRegistry;
  pluginEnvVars: Record<string, string>;
  compose: ComposeContext;
  timings: StartTimings;
};

export type StopOptions = {
  workspaceDir?: string;
  /** In-memory handles from a running workspace. When provided, stop uses these
   *  directly instead of hydrating from the on-disk state file. */
  handles?: ServiceHandle[];
  /** Remove volumes and orphan containers (docker compose down -v --remove-orphans). */
  clean?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: OrchestratorEvent) => void;
};

export type ServiceState = {
  runner: "process" | "container" | "compose";
  pid?: number;
  containerId?: string;
};

export type WorkspaceState = {
  workspaceName: string;
  projectName: string;
  fileArgs: string[];
  workspaceDir: string;
  services: Record<string, ServiceState>;
  /** Plugin env vars the services were started with, so a restart can reuse them. */
  pluginEnvVars?: Record<string, string>;
  /** The `lo1 up --mode` override, so a restart runs the service the same way. */
  modeOverride?: "dev" | "container";
};
