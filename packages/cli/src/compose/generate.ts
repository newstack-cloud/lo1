import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform } from "node:os";
import { dump as toYaml } from "js-yaml";
import type { WorkspaceConfig, ComposeContribution, ComposeServiceDef } from "@lo1/sdk";

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

export type ComposeResult = {
  yaml: string;
  fileArgs: string[];
  projectName: string;
  pluginEnvVars: Record<string, string>;
};

type ComposeDocService = ComposeServiceDef & {
  networks?: string[];
  restart?: string;
  extra_hosts?: string[];
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
  const projectName = `lo1-${config.name}`;

  const doc: ComposeDocument = {
    name: projectName,
    services: {},
    networks: { lo1: { driver: "bridge" } },
    volumes: {},
  };

  addContainerServices(doc, config);

  const pluginEnvVars = mergeContributions(doc, contributions);

  if (config.proxy?.enabled !== false) {
    addProxyService(doc, config);
  }

  const fileArgs = buildFileArgs(config);
  const yaml = toYaml(doc, { noRefs: true, lineWidth: -1 });

  return { yaml, fileArgs, projectName, pluginEnvVars };
}

function addContainerServices(doc: ComposeDocument, config: WorkspaceConfig): void {
  for (const [name, service] of Object.entries(config.services)) {
    if (service.mode !== "container") continue;

    if (!service.containerImage) {
      throw new ComposeError(`Service "${name}" is in container mode but has no containerImage`);
    }

    const svc: ComposeDocService = {
      image: service.containerImage,
      networks: ["lo1"],
    };

    if (service.port) {
      svc.ports = [`${service.port}:${service.port}`];
    }

    if (service.env && Object.keys(service.env).length > 0) {
      svc.environment = { ...service.env };
    }

    doc.services[name] = svc;
  }
}

function mergeContributions(
  doc: ComposeDocument,
  contributions?: ComposeContribution[],
): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (!contributions) return envVars;

  for (const contribution of contributions) {
    for (const [name, svc] of Object.entries(contribution.services)) {
      doc.services[name] = { ...svc, networks: ["lo1"] };
    }
    Object.assign(envVars, contribution.envVars);
  }

  return envVars;
}

function addProxyService(doc: ComposeDocument, config: WorkspaceConfig): void {
  const proxyPort = config.proxy?.port ?? 80;
  const tlsEnabled = config.proxy?.tls?.enabled === true;
  const tlsPort = config.proxy?.tls?.port ?? 443;

  const ports = [`${proxyPort}:80`];
  if (tlsEnabled) {
    ports.push(`${tlsPort}:443`);
  }

  const proxySvc: ComposeDocService = {
    image: "caddy:2-alpine",
    ports,
    volumes: [".lo1/Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data"],
    restart: "unless-stopped",
    networks: ["lo1"],
  };

  // On Linux, Docker Engine doesn't provide host.docker.internal by default
  if (platform() === "linux") {
    proxySvc.extra_hosts = ["host.docker.internal:host-gateway"];
  }

  doc.services["lo1-proxy"] = proxySvc;
  doc.volumes["caddy_data"] = {};
}

function buildFileArgs(config: WorkspaceConfig): string[] {
  const fileArgs: string[] = [join(".lo1", "compose.generated.yaml")];

  for (const [, service] of Object.entries(config.services)) {
    if (service.compose) {
      fileArgs.push(resolve(service.path, service.compose));
    }
  }

  if (config.extraCompose) {
    fileArgs.push(config.extraCompose);
  }

  return fileArgs;
}

export async function writeComposeFile(yaml: string, workspaceDir = "."): Promise<string> {
  const dir = join(workspaceDir, ".lo1");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "compose.generated.yaml");
  await writeFile(filePath, yaml, "utf-8");
  return filePath;
}
