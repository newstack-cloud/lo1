import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceConfig } from "@lo1/sdk";
import { collectDomains } from "./domains";

export type CaddyfileResult = {
  content: string;
  domains: string[];
};

type RouteEntry = {
  type: "reverse_proxy" | "path_prefix";
  pathPrefix?: string;
  upstream: string;
};

export function generateCaddyfile(config: WorkspaceConfig): CaddyfileResult {
  const tld = config.proxy?.tld ?? "local";
  const baseDomain = `${config.name}.${tld}`;
  const tlsEnabled = config.proxy?.tls?.enabled === true;

  const routeMap = buildRouteMap(config, baseDomain);
  const blocks = [...routeMap.entries()].map(([domain, routes]) =>
    renderBlock(domain, routes, tlsEnabled),
  );

  const content = blocks.join("\n\n") + "\n";
  const domains = collectDomains(config);

  return { content, domains };
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
      addRoute(routeMap, service.proxy.domain, { type: "reverse_proxy", upstream });
    }
  }

  return routeMap;
}

function addRoute(routeMap: Map<string, RouteEntry[]>, domain: string, entry: RouteEntry): void {
  const routes = routeMap.get(domain) ?? [];
  routes.push(entry);
  routeMap.set(domain, routes);
}

function renderBlock(domain: string, routes: RouteEntry[], tlsEnabled: boolean): string {
  const lines: string[] = [`${domain} {`];

  if (tlsEnabled) {
    lines.push("  tls internal");
  }

  for (const route of routes) {
    lines.push(...renderRoute(route));
  }

  lines.push("}");
  return lines.join("\n");
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
  return filePath;
}
