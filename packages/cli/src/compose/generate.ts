import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { platform } from "node:os";
import { dump as toYaml, load as parseYaml } from "js-yaml";
import type {
  WorkspaceConfig,
  ComposeContribution,
  ComposeServiceDef,
  ServiceConfig,
} from "@lo1/sdk";
import { buildEndpointRegistry, buildServiceEnv } from "../discovery/registry";
import { ACME_DOCKERFILE, acmeEnvironment, getAcmeConfig, proxyImageTag } from "../tls/acme";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("compose");

export function projectId(workspaceName: string): string {
  return `lo1-${workspaceName}`;
}

export function networkId(workspaceName: string): string {
  return `lo1-${workspaceName}-network`;
}

export function proxyServiceId(workspaceName: string): string {
  return `lo1-${workspaceName}-proxy`;
}

export class ComposeError extends Lo1Error {
  constructor(message: string) {
    super(message, "ComposeError");
    this.name = "ComposeError";
  }
}

export type ComposeResult = {
  yaml: string;
  fileArgs: string[];
  projectName: string;
  pluginEnvVars: Record<string, string>;
  infraServices: string[];
  appServices: string[];
};

type ComposeDocService = ComposeServiceDef & {
  container_name?: string;
  networks?: string[];
  restart?: string;
  extra_hosts?: string[];
  build?: { context: string; dockerfile: string };
};

type ComposeDocument = {
  name: string;
  services: Record<string, ComposeDocService>;
  networks: Record<string, { driver: string }>;
  volumes: Record<string, Record<string, never>>;
};

export function generateCompose(
  config: WorkspaceConfig,
  contributions?: ComposeContribution[],
): ComposeResult {
  const projectName = projectId(config.name);
  debug("generateCompose: project=%s", projectName);

  const doc: ComposeDocument = {
    name: projectName,
    services: {},
    networks: { [networkId(config.name)]: { driver: "bridge" } },
    volumes: {},
  };

  const { envVars: pluginEnvVars, serviceNames: infraServices } = mergeContributions(
    doc,
    config.name,
    contributions,
  );

  const appServices = addContainerServices(doc, config, containerEnvBuilder(config, pluginEnvVars));

  if (config.proxy?.enabled !== false) {
    addProxyService(doc, config);
    infraServices.push(proxyServiceId(config.name));
  }

  // Services with per-service compose files are app services
  for (const [name, service] of Object.entries(config.services)) {
    if (service.compose) appServices.push(name);
  }

  const fileArgs = buildFileArgs(config);
  const yaml = toYaml(doc, { noRefs: true, lineWidth: -1 });

  debug("generateCompose: infra=%d app=%d services", infraServices.length, appServices.length);
  return { yaml, fileArgs, projectName, pluginEnvVars, infraServices, appServices };
}

type ContainerEnvBuilder = (name: string, service: ServiceConfig) => Record<string, string>;

/**
 * Builds the environment lo1 gives a service it runs in a container: discovery
 * variables for every other service, plugin variables, then the service's own env.
 */
export function containerEnvBuilder(
  config: WorkspaceConfig,
  pluginEnvVars: Record<string, string>,
): ContainerEnvBuilder {
  const registry = buildEndpointRegistry(config);
  return (name, service) =>
    buildServiceEnv(name, service, config, registry, pluginEnvVars, "container");
}

const GATEWAY_HOST = "host.docker.internal";

/** Docker Engine on Linux has no host.docker.internal unless it is mapped. */
function hostGatewayEntries(): string[] | undefined {
  return platform() === "linux" ? [`${GATEWAY_HOST}:host-gateway`] : undefined;
}

type ExtraHosts = string[] | Record<string, string | string[]>;

function mapsGatewayHost(extraHosts: ExtraHosts): boolean {
  if (!Array.isArray(extraHosts)) return GATEWAY_HOST in extraHosts;
  // List entries are "host:ip" or "host=ip".
  return extraHosts.some((entry) => entry.split(/[:=]/)[0].trim() === GATEWAY_HOST);
}

/**
 * Adds lo1's host-gateway mapping to a compose service's extra_hosts on Linux,
 * keeping the entries already there. A mapping of host.docker.internal the
 * compose file declares itself is left alone.
 */
export function withHostGateway(
  extraHosts: ExtraHosts | undefined,
  os: NodeJS.Platform = platform(),
): ExtraHosts | undefined {
  if (os !== "linux") return extraHosts;
  if (extraHosts === undefined) return [`${GATEWAY_HOST}:host-gateway`];
  if (mapsGatewayHost(extraHosts)) return extraHosts;
  if (Array.isArray(extraHosts)) return [...extraHosts, `${GATEWAY_HOST}:host-gateway`];
  return { ...extraHosts, [GATEWAY_HOST]: "host-gateway" };
}

function addContainerServices(
  doc: ComposeDocument,
  config: WorkspaceConfig,
  envFor: ContainerEnvBuilder,
): string[] {
  const netId = networkId(config.name);
  const names: string[] = [];

  for (const [name, service] of Object.entries(config.services)) {
    if (service.mode !== "container") continue;
    if (service.compose) continue;

    if (!service.containerImage) {
      throw new ComposeError(
        `Service "${name}" is in container mode but has no containerImage or compose file`,
      );
    }

    const svc: ComposeDocService = {
      image: service.containerImage,
      networks: [netId],
      environment: envFor(name, service),
    };

    if (service.port) {
      svc.ports = [`${service.port}:${service.port}`];
    }

    const extraHosts = hostGatewayEntries();
    if (extraHosts) svc.extra_hosts = extraHosts;

    doc.services[name] = svc;
    names.push(name);
  }

  return names;
}

function mergeContributions(
  doc: ComposeDocument,
  workspaceName: string,
  contributions?: ComposeContribution[],
): { envVars: Record<string, string>; serviceNames: string[] } {
  const envVars: Record<string, string> = {};
  const serviceNames: string[] = [];
  if (!contributions) return { envVars, serviceNames };

  const netId = networkId(workspaceName);
  for (const contribution of contributions) {
    for (const [name, svc] of Object.entries(contribution.services)) {
      doc.services[name] = { ...svc, networks: [netId] };
      serviceNames.push(name);
    }
    Object.assign(envVars, contribution.envVars);
  }

  return { envVars, serviceNames };
}

function addProxyService(doc: ComposeDocument, config: WorkspaceConfig): void {
  const proxyPort = config.proxy?.port ?? 80;
  const tlsEnabled = config.proxy?.tls?.enabled === true;
  const tlsPort = config.proxy?.tls?.port ?? 443;

  const ports = [`${proxyPort}:80`];
  if (tlsEnabled) {
    ports.push(`${tlsPort}:443`);
  }

  const proxyContainerName = `${projectId(config.name)}-proxy`;
  const proxySvc: ComposeDocService = {
    container_name: proxyContainerName,
    image: "caddy:2-alpine",
    ports,
    volumes: [".lo1/Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data"],
    restart: "unless-stopped",
    networks: [networkId(config.name)],
  };

  applyAcmeImage(proxySvc, config);

  const extraHosts = hostGatewayEntries();
  if (extraHosts) proxySvc.extra_hosts = extraHosts;

  doc.services[proxyServiceId(config.name)] = proxySvc;
  doc.volumes["caddy_data"] = {};
}

/**
 * Under `mode: acme` the proxy runs a Caddy build that includes the DNS
 * provider module, and receives the provider credentials by env passthrough.
 */
function applyAcmeImage(proxySvc: ComposeDocService, config: WorkspaceConfig): void {
  const acme = getAcmeConfig(config);
  if (!acme) return;

  proxySvc.image = proxyImageTag(acme);
  if (!acme.image) {
    proxySvc.build = { context: ".lo1", dockerfile: ACME_DOCKERFILE };
  }

  const environment = acmeEnvironment(acme);
  if (Object.keys(environment).length > 0) {
    proxySvc.environment = { ...proxySvc.environment, ...environment };
  }
}

/** Returns the extraCompose file path from either the string or object form. */
export function extraComposeFile(config: WorkspaceConfig): string | undefined {
  if (!config.extraCompose) return undefined;
  return typeof config.extraCompose === "string" ? config.extraCompose : config.extraCompose.file;
}

/** Returns the initTaskServices declared in the extraCompose object form, or []. */
export function extraComposeInitTasks(config: WorkspaceConfig): string[] {
  if (!config.extraCompose || typeof config.extraCompose === "string") return [];
  return config.extraCompose.initTaskServices ?? [];
}

function buildFileArgs(config: WorkspaceConfig): string[] {
  const fileArgs: string[] = [join(".lo1", "compose.generated.yaml")];

  // Per-service compose files are preprocessed into .lo1/ with resolved paths
  for (const [name, service] of Object.entries(config.services)) {
    if (service.compose) {
      fileArgs.push(join(".lo1", `${name}.compose.yaml`));
    }
  }

  const ecFile = extraComposeFile(config);
  if (ecFile) {
    fileArgs.push(ecFile);
  }

  return fileArgs;
}

/**
 * Determines if a volume host path is a relative file path (not a named volume).
 * Named volumes are bare names like "data_volume", relative paths start with . or ..
 */
function isRelativeHostPath(host: string): boolean {
  return host.startsWith(".") || host.includes("/");
}

type ParsedComposeService = {
  build?: { context?: string };
  volumes?: (string | Record<string, unknown>)[];
  env_file?: string | string[];
  environment?: string[] | Record<string, string | number | boolean | null>;
  extra_hosts?: ExtraHosts;
  network_mode?: string;
  networks?: string[] | Record<string, unknown>;
};

type ParsedComposeDoc = {
  services?: Record<string, ParsedComposeService>;
};

/**
 * Resolves relative paths in a compose service definition to absolute paths
 * based on the service's source directory. This allows per-service compose files
 * to use natural relative paths (e.g., `.:/app`, `env_file: .env`) while being
 * merged with compose files from other directories.
 */
function resolveComposePaths(svc: ParsedComposeService, serviceDir: string): void {
  // build.context is always relative to compose file's directory
  if (svc.build?.context && !isAbsolute(svc.build.context)) {
    svc.build.context = resolve(serviceDir, svc.build.context);
  }

  // Resolve host paths in volume mounts
  if (Array.isArray(svc.volumes)) {
    svc.volumes = svc.volumes.map((v) => {
      if (typeof v !== "string") return v;
      const parts = v.split(":");
      if (parts.length < 2) return v; // anonymous volume like /app/node_modules
      const host = parts[0];
      if (isAbsolute(host)) return v; // already absolute
      if (!isRelativeHostPath(host)) return v; // named volume
      parts[0] = resolve(serviceDir, host);
      return parts.join(":");
    });
  }

  // Resolve env_file paths
  if (Array.isArray(svc.env_file)) {
    svc.env_file = svc.env_file.map((f) => (isAbsolute(f) ? f : resolve(serviceDir, f)));
  } else if (typeof svc.env_file === "string" && !isAbsolute(svc.env_file)) {
    svc.env_file = resolve(serviceDir, svc.env_file);
  }
}

/**
 * Adds lo1's environment to the compose service that shares the lo1 service's
 * name. Values the compose file sets itself take precedence.
 */
function injectLo1Environment(svc: ParsedComposeService, lo1Env: Record<string, string>): void {
  const own = svc.environment ?? {};
  if (Array.isArray(own)) {
    const ownKeys = new Set(own.map((entry) => entry.split("=")[0]));
    const added = Object.entries(lo1Env)
      .filter(([key]) => !ownKeys.has(key))
      .map(([key, value]) => `${key}=${value}`);
    svc.environment = [...added, ...own];
  } else {
    svc.environment = { ...lo1Env, ...own };
  }

  const extraHosts = withHostGateway(svc.extra_hosts);
  if (extraHosts) svc.extra_hosts = extraHosts;
}

/**
 * Puts a compose-file service on the workspace network, where the names in
 * lo1's discovery variables resolve and the proxy can reach it. Networks the
 * file lists are kept; with none listed the service also stays on `default`,
 * so siblings in its own file still reach it. `network_mode` is left alone,
 * since Compose doesn't allow it alongside `networks`.
 */
export function joinWorkspaceNetwork(svc: ParsedComposeService, netId: string): void {
  if (svc.network_mode !== undefined) return;
  const networks = svc.networks;
  if (networks === undefined) {
    svc.networks = ["default", netId];
  } else if (Array.isArray(networks)) {
    if (!networks.includes(netId)) svc.networks = [...networks, netId];
  } else if (!(netId in networks)) {
    svc.networks = { ...networks, [netId]: null };
  }
}

/**
 * Reads per-service compose files, resolves all relative paths to absolute
 * based on each service's directory, and writes resolved copies to .lo1/.
 * This ensures Docker Compose path resolution works correctly regardless
 * of the project directory.
 */
export async function preprocessServiceComposeFiles(
  config: WorkspaceConfig,
  workspaceDir = ".",
  pluginEnvVars: Record<string, string> = {},
): Promise<void> {
  const lo1Dir = join(workspaceDir, ".lo1");
  await mkdir(lo1Dir, { recursive: true });
  const envFor = containerEnvBuilder(config, pluginEnvVars);

  for (const [name, service] of Object.entries(config.services)) {
    if (!service.compose) continue;

    const composeFilePath = resolve(service.path, service.compose);
    const raw = await readFile(composeFilePath, "utf-8");
    const doc = parseYaml(raw) as ParsedComposeDoc;
    const serviceDir = resolve(service.path);

    for (const svc of Object.values(doc.services ?? {})) {
      resolveComposePaths(svc, serviceDir);
    }

    const lo1Service = doc.services?.[name];
    if (lo1Service) {
      injectLo1Environment(lo1Service, envFor(name, service));
      joinWorkspaceNetwork(lo1Service, networkId(config.name));
    }

    const resolvedYaml = toYaml(doc, { noRefs: true, lineWidth: -1 });
    await writeFile(join(lo1Dir, `${name}.compose.yaml`), resolvedYaml, "utf-8");
  }
}

/**
 * Reads an extraCompose YAML file and returns the service names defined in it.
 * These are infrastructure-level services (databases, caches, init containers)
 * that need to be started alongside plugin contributions.
 */
export async function discoverExtraComposeServices(
  extraComposePath: string,
  workspaceDir = ".",
): Promise<string[]> {
  const filePath = resolve(workspaceDir, extraComposePath);
  const raw = await readFile(filePath, "utf-8");
  const doc = parseYaml(raw) as ParsedComposeDoc;
  return Object.keys(doc.services ?? {});
}

export async function writeComposeFile(yaml: string, workspaceDir = "."): Promise<string> {
  const dir = join(workspaceDir, ".lo1");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "compose.generated.yaml");
  await writeFile(filePath, yaml, "utf-8");
  debug("writeComposeFile: %s", filePath);
  return filePath;
}
