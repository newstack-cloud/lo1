import type { Plugin, PluginContext, WorkspaceConfig, ComposeContribution } from "@lo1/sdk";
import type { EndpointRegistry } from "../discovery/registry";
import type { DagResult } from "../dag/index";
import type { ComposeResult } from "../compose/generate";
import type { CaddyfileResult } from "../proxy/caddyfile";
import type { OutputLine } from "../runner/process";
import type { HookOutput, HookResult } from "../hooks/executor";
import type { ComposeExecOptions, ComposeServiceStatus } from "../runner/compose";
import type { ServiceHandle, StartServiceOptions } from "./service";

export type OrchestratorEvent =
  | { kind: "phase"; phase: string }
  | { kind: "service"; service: string; status: "starting" | "started" | "stopping" | "stopped" }
  | { kind: "hook"; hook: string; output: HookOutput }
  | { kind: "output"; line: OutputLine }
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
  writeCaddyfile: (content: string, workspaceDir?: string) => Promise<string>;
  generateHostsBlock: (domains: string[]) => string;
  applyHosts: (block: string) => Promise<void>;
  removeHosts: () => Promise<void>;
  composeUp: (options: ComposeExecOptions) => Promise<void>;
  composeDown: (options: ComposeExecOptions) => Promise<void>;
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
};

export type StartOptions = {
  configPath?: string;
  workspaceDir?: string;
  serviceFilter?: string[];
  modeOverride?: "dev" | "container";
  signal?: AbortSignal;
  onEvent?: (event: OrchestratorEvent) => void;
};

export type StartResult = {
  handles: ServiceHandle[];
  composeOptions: ComposeExecOptions;
  config: WorkspaceConfig;
};

export type StopOptions = {
  workspaceDir?: string;
  /** In-memory handles from a running workspace. When provided, stop uses these
   *  directly instead of hydrating from the on-disk state file. */
  handles?: ServiceHandle[];
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
};
