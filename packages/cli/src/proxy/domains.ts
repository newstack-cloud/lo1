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
      domains.add(service.proxy.domain);
    }
  }

  return [...domains];
}
