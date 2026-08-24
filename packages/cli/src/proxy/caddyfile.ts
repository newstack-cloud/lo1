import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcmeConfig, WorkspaceConfig } from "@lo1/sdk";
import { collectDomains } from "./domains";
import {
  getAcmeConfig,
  isAcmeDomain,
  renderAcmeTlsBlock,
  renderGlobalOptions,
  wildcardFor,
} from "../tls/acme";
import { createLog } from "../debug";

const debug = createLog("proxy");

export type CaddyfileResult = {
  content: string;
  domains: string[];
  /** Domains served by Caddy's internal CA, so the caller knows whether to trust it. */
  internalDomains: string[];
};

type RouteEntry = {
  type: "reverse_proxy" | "path_prefix";
  pathPrefix?: string;
  upstream: string;
};

/** A group of routes reached through one hostname within a site block. */
type HostGroup = {
  /** Set only when the block serves several hostnames and must match on Host. */
  host?: string;
  routes: RouteEntry[];
};

type SiteBlock = {
  address: string;
  groups: HostGroup[];
  /** Hostnames this block serves, used to decide which TLS directive applies. */
  domains: string[];
  /** True when ACME issues for this block rather than the internal CA. */
  useAcme: boolean;
};

export function generateCaddyfile(config: WorkspaceConfig): CaddyfileResult {
  const tld = config.proxy?.tld ?? "local";
  const baseDomain = `${config.name}.${tld}`;
  const tlsEnabled = config.proxy?.tls?.enabled === true;
  const acme = getAcmeConfig(config);

  const routeMap = buildRouteMap(config, baseDomain);
  const blocks = buildSiteBlocks(routeMap, acme);

  const internalDomains: string[] = [];
  const rendered = blocks.map((block) => {
    if (tlsEnabled && !block.useAcme) internalDomains.push(...block.domains);
    return renderBlock(block, renderTlsDirective(tlsEnabled, block.useAcme ? acme : undefined));
  });

  const globalOptions = renderGlobalOptions(acme);
  const sections = globalOptions.length > 0 ? [globalOptions.join("\n"), ...rendered] : rendered;
  const content = sections.join("\n\n") + "\n";
  const domains = collectDomains(config);

  debug(
    "generateCaddyfile: %d blocks, tls=%s, mode=%s, %d domains",
    blocks.length,
    tlsEnabled,
    config.proxy?.tls?.mode ?? "internal",
    domains.length,
  );
  return { content, domains, internalDomains };
}

function buildRouteMap(config: WorkspaceConfig, baseDomain: string): Map<string, RouteEntry[]> {
  const routeMap = new Map<string, RouteEntry[]>();

  for (const [name, service] of Object.entries(config.services)) {
    if (service.mode === "skip" || !service.port) continue;

    const upstream =
      service.mode === "container"
        ? `${name}:${service.port}`
        : `host.docker.internal:${service.port}`;

    addRoute(routeMap, `${name}.${baseDomain}`, { type: "reverse_proxy", upstream });

    if (service.proxy?.pathPrefix) {
      addRoute(routeMap, baseDomain, {
        type: "path_prefix",
        pathPrefix: service.proxy.pathPrefix,
        upstream,
      });
    }

    if (service.proxy?.domain) {
      const domains = Array.isArray(service.proxy.domain)
        ? service.proxy.domain
        : [service.proxy.domain];
      for (const domain of domains) {
        addRoute(routeMap, domain, { type: "reverse_proxy", upstream });
      }
    }
  }

  return routeMap;
}

function addRoute(routeMap: Map<string, RouteEntry[]>, domain: string, entry: RouteEntry): void {
  const routes = routeMap.get(domain) ?? [];
  routes.push(entry);
  routeMap.set(domain, routes);
}

/**
 * One site block per domain, except that every host covered by a declared
 * `acme.domains` wildcard is folded into a single `*.<name>` block so Caddy
 * obtains one certificate for the whole set instead of one per host.
 */
function buildSiteBlocks(
  routeMap: Map<string, RouteEntry[]>,
  acme: AcmeConfig | undefined,
): SiteBlock[] {
  const standalone: SiteBlock[] = [];
  const wildcardGroups = new Map<string, SiteBlock>();

  for (const [domain, routes] of routeMap) {
    const wildcard = acme ? wildcardFor(acme, domain) : undefined;
    if (!wildcard) {
      standalone.push({
        address: domain,
        groups: [{ routes }],
        domains: [domain],
        useAcme: acme !== undefined && isAcmeDomain(acme, domain),
      });
      continue;
    }

    const block = wildcardGroups.get(wildcard) ?? {
      address: wildcard,
      groups: [],
      domains: [],
      useAcme: true,
    };
    block.groups.push({ host: domain, routes });
    block.domains.push(domain);
    wildcardGroups.set(wildcard, block);
  }

  return [...wildcardGroups.values(), ...standalone];
}

function renderTlsDirective(tlsEnabled: boolean, acme: AcmeConfig | undefined): string[] {
  if (!tlsEnabled) return [];
  return acme ? renderAcmeTlsBlock(acme) : ["  tls internal"];
}

function renderBlock(block: SiteBlock, tlsLines: string[]): string {
  const lines: string[] = [`${block.address} {`, ...tlsLines];

  const needsHostMatchers = block.groups.length > 1 || block.groups.some((g) => g.host);
  for (const group of block.groups) {
    lines.push(...(needsHostMatchers ? renderHostGroup(group) : group.routes.flatMap(renderRoute)));
  }

  lines.push("}");
  return lines.join("\n");
}

function renderHostGroup(group: HostGroup): string[] {
  if (!group.host) return group.routes.flatMap(renderRoute);

  const matcher = `@${group.host.replaceAll(/[^a-zA-Z0-9]/g, "_")}`;
  return [
    `  ${matcher} host ${group.host}`,
    `  handle ${matcher} {`,
    ...group.routes.flatMap(renderRoute).map((line) => `  ${line}`),
    "  }",
  ];
}

function renderRoute(route: RouteEntry): string[] {
  if (route.type === "reverse_proxy") {
    return [`  reverse_proxy ${route.upstream}`];
  }
  return [`  handle ${route.pathPrefix}/* {`, `    reverse_proxy ${route.upstream}`, "  }"];
}

export async function writeCaddyfile(content: string, workspaceDir = "."): Promise<string> {
  const dir = join(workspaceDir, ".lo1");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "Caddyfile");
  await writeFile(filePath, content, "utf-8");
  debug("writeCaddyfile: %s", filePath);
  return filePath;
}
