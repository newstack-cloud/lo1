import type { ServiceConfig } from "./config/index";

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface PluginContext {
  workspaceDir: string;
  workspaceName: string;
  logger: Logger;
}

export type PluginFactory = (context: PluginContext) => Plugin | Promise<Plugin>;

export interface Plugin {
  /** Plugin identifier — matches service `type` in manifest. */
  name: string;

  /**
   * Inspects all services of this plugin's type and returns
   * compose service definitions for shared infrastructure.
   * Called once with ALL services of this type — the plugin deduplicates internally.
   */
  contributeCompose?(input: ComposeInput): Promise<ComposeContribution>;

  /**
   * Creates infrastructure resources (tables, buckets, schemas)
   * after the compose stack is healthy. Called once per service of this type.
   */
  provisionInfra?(input: ProvisionInput): Promise<ProvisionResult>;

  /**
   * Applies seed data to provisioned infrastructure.
   * Called once per service of this type, after provisionInfra.
   */
  seedData?(input: SeedInput): Promise<SeedResult>;

  /**
   * Returns the container configuration for running a service.
   * Only called for services in container/dev mode (not host process mode).
   */
  configureContainer?(input: ContainerInput): Promise<ContainerConfig>;

  /**
   * Sets up file watchers that trigger rebuilds/restarts.
   * Returns an async iterable that yields restart signals. Optional.
   */
  watchForChanges?(input: WatchInput): AsyncIterable<RestartSignal>;
}

export interface ComposeInput {
  services: Record<string, ServiceConfig>;
  workspaceDir: string;
}

export interface ComposeServiceDef {
  image: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  command?: string[];
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  depends_on?: Record<string, { condition: string }>;
}

export interface ComposeContribution {
  services: Record<string, ComposeServiceDef>;
  envVars: Record<string, string>;
}

export interface ProvisionInput {
  serviceName: string;
  servicePath: string;
  endpoints: Record<string, string>;
}

export interface ProvisionResult {
  created: string[];
  skipped: string[];
}

export interface SeedInput {
  serviceName: string;
  servicePath: string;
  mode: "run" | "test";
  endpoints: Record<string, string>;
}

export interface SeedResult {
  applied: string[];
}

export interface ContainerInput {
  serviceName: string;
  servicePath: string;
  servicePort: string;
  mode: "dev" | "container";
  networkName: string;
  endpoints: Record<string, string>;
}

export interface ContainerConfig {
  image: string;
  cmd: string[];
  envVars: Record<string, string>;
  binds: string[];
  workingDir: string;
}

export interface WatchInput {
  serviceName: string;
  servicePath: string;
}

export interface RestartSignal {
  reason: string;
  changedFiles?: string[];
}
