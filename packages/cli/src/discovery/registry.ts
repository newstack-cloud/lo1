import type { WorkspaceConfig, ServiceConfig } from "@lo1/sdk";
import { createLog } from "../debug";

const debug = createLog("discovery");

export type ServiceEndpoint = {
  name: string;
  port: number;
  hostPort: number;
  internalUrl: string;
  externalUrl: string;
  proxyUrl: string;
  mode: "dev" | "container" | "skip";
};

export type EndpointRegistry = {
  endpoints: Map<string, ServiceEndpoint>;
};

export function toEnvKey(name: string): string {
  return name.replaceAll("-", "_").toUpperCase();
}

export function buildEndpointRegistry(config: WorkspaceConfig): EndpointRegistry {
  const endpoints = new Map<string, ServiceEndpoint>();
  const tld = config.proxy?.tld ?? "local";
  const tlsEnabled = config.proxy?.tls?.enabled === true;
  const scheme = tlsEnabled ? "https" : "http";

  debug("buildEndpointRegistry: %d services", Object.keys(config.services).length);

  for (const [name, service] of Object.entries(config.services)) {
    if (!service.port || service.mode === "skip") continue;

    const hostPort = service.hostPort ?? service.port;
    endpoints.set(name, {
      name,
      port: service.port,
      hostPort,
      internalUrl: `http://${name}:${service.port}`,
      externalUrl: `http://localhost:${hostPort}`,
      proxyUrl: `${scheme}://${name}.${config.name}.${tld}`,
      mode: service.mode,
    });
  }

  debug("buildEndpointRegistry: %d endpoints registered", endpoints.size);
  return { endpoints };
}

/** Hostname a container uses to reach a process running on the host. */
export const HOST_GATEWAY = "host.docker.internal";

/**
 * How a container reaches an endpoint: by service name on the compose network
 * when the target is itself a container, or through the host gateway when the
 * target is in dev mode. A dev-mode service is either a process on the host or
 * a plugin's container, which publishes its port on the host for this reason.
 */
export function containerFacingUrl(endpoint: ServiceEndpoint): string {
  if (endpoint.mode === "dev") return `http://${HOST_GATEWAY}:${endpoint.hostPort}`;
  return endpoint.internalUrl;
}

function containerFacingPort(endpoint: ServiceEndpoint): number {
  return endpoint.mode === "dev" ? endpoint.hostPort : endpoint.port;
}

export function buildDiscoveryEnvVars(
  registry: EndpointRegistry,
  consumerMode: "container" | "host",
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, endpoint] of registry.endpoints) {
    const key = toEnvKey(name);
    const isContainer = consumerMode === "container";
    const url = isContainer ? containerFacingUrl(endpoint) : endpoint.externalUrl;
    const port = isContainer ? containerFacingPort(endpoint) : endpoint.hostPort;
    env[`LO1_SERVICE_${key}_URL`] = url;
    env[`LO1_SERVICE_${key}_PORT`] = String(port);
    env[`LO1_SERVICE_${key}_PROXY_URL`] = endpoint.proxyUrl;
  }

  return env;
}

export function translatePluginEnvVars(
  pluginEnvVars: Record<string, string>,
  registry: EndpointRegistry,
): Record<string, string> {
  const translated: Record<string, string> = {};

  for (const [key, value] of Object.entries(pluginEnvVars)) {
    let result = value;
    for (const [name, endpoint] of registry.endpoints) {
      result = result.replaceAll(`${name}:${endpoint.port}`, `localhost:${endpoint.hostPort}`);
    }
    translated[key] = result;
  }

  return translated;
}

export function buildServiceEnv(
  serviceName: string,
  serviceConfig: ServiceConfig,
  config: WorkspaceConfig,
  registry: EndpointRegistry,
  pluginEnvVars: Record<string, string>,
  consumerMode: "container" | "host",
): Record<string, string> {
  debug("buildServiceEnv: service=%s consumer=%s", serviceName, consumerMode);
  const discoveryVars = buildDiscoveryEnvVars(registry, consumerMode);

  const translatedPluginVars =
    consumerMode === "host"
      ? translatePluginEnvVars(pluginEnvVars, registry)
      : { ...pluginEnvVars };

  return {
    ...discoveryVars,
    ...translatedPluginVars,
    ...(serviceConfig.env ?? {}),
    LO1_SERVICE_NAME: serviceName,
    LO1_WORKSPACE_NAME: config.name,
  };
}
