import type { WorkspaceConfig } from "@lo1/sdk";

/**
 * Collects all proxy domains from workspace config.
 * Used by Caddyfile generation, hosts management, and TLS setup.
 */
export function collectDomains(config: WorkspaceConfig): string[] {
  const tld = config.proxy?.tld ?? "local";
  const baseDomain = `${config.name}.${tld}`;
  const domains = new Set<string>();

  for (const [name, service] of Object.entries(config.services)) {
    if (service.mode === "skip" || !service.port) continue;

    domains.add(`${name}.${baseDomain}`);

    if (service.proxy?.pathPrefix) {
      domains.add(baseDomain);
    }

    if (service.proxy?.domain) {
      const serviceDomains = Array.isArray(service.proxy.domain)
        ? service.proxy.domain
        : [service.proxy.domain];
      for (const domain of serviceDomains) {
        domains.add(domain);
      }
    }
  }

  return [...domains];
}

function portSuffix(port: number, defaultPort: number): string {
  return port === defaultPort ? "" : `:${port}`;
}

/**
 * The URL to open a service at: through the proxy on its first domain, or
 * straight to its host port when the proxy is disabled. Undefined for
 * services with no port, skip-mode services and init tasks.
 */
export function serviceUrl(config: WorkspaceConfig, name: string): string | undefined {
  const service = config.services[name];
  if (!service?.port || service.mode === "skip" || service.initTask) return undefined;

  if (config.proxy?.enabled === false) {
    const port = service.mode === "container" ? (service.hostPort ?? service.port) : service.port;
    return `http://localhost:${port}`;
  }

  const tls = config.proxy?.tls?.enabled === true;
  const suffix = tls
    ? portSuffix(config.proxy?.tls?.port ?? 443, 443)
    : portSuffix(config.proxy?.port ?? 80, 80);
  const custom = service.proxy?.domain;
  const domain =
    (Array.isArray(custom) ? custom[0] : custom) ??
    `${name}.${config.name}.${config.proxy?.tld ?? "local"}`;
  return `${tls ? "https" : "http"}://${domain}${suffix}`;
}
