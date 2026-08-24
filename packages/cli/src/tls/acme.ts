import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcmeConfig, WorkspaceConfig } from "@lo1/sdk";
import { createLog } from "../debug";
import { TlsError } from "./setup";

const debug = createLog("proxy");

/** Filename of the generated proxy Dockerfile inside `.lo1`. */
export const ACME_DOCKERFILE = "Dockerfile.proxy";

const CA_DIRECTORIES: Record<string, string> = {
  letsencrypt: "https://acme-v02.api.letsencrypt.org/directory",
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
  zerossl: "https://acme.zerossl.com/v2/DV90",
};

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Matches a single leading wildcard label, as ACME and Caddy do. */
export function matchesDomainPattern(pattern: string, domain: string): boolean {
  const p = pattern.trim().toLowerCase();
  const d = domain.trim().toLowerCase();
  if (p === d) return true;
  if (!p.startsWith("*.")) return false;

  const suffix = p.slice(1);
  if (!d.endsWith(suffix)) return false;
  const label = d.slice(0, d.length - suffix.length);
  return label.length > 0 && !label.includes(".");
}

/**
 * Whether ACME should issue for `domain`. With no `domains` declared ACME
 * covers everything; otherwise only the declared names, so non-public hosts
 * keep using the internal CA.
 */
export function isAcmeDomain(acme: AcmeConfig, domain: string): boolean {
  if (acme.domains.length === 0) return true;
  return acme.domains.some((pattern) => matchesDomainPattern(pattern, domain));
}

/** The declared wildcard a domain belongs under, if any. */
export function wildcardFor(acme: AcmeConfig, domain: string): string | undefined {
  return acme.domains.find(
    (pattern) => pattern.startsWith("*.") && matchesDomainPattern(pattern, domain),
  );
}

export function isAcmeTls(config: WorkspaceConfig): boolean {
  return config.proxy?.tls?.enabled === true && config.proxy.tls.mode === "acme";
}

/** Returns the validated ACME config when the workspace uses `mode: acme`. */
export function getAcmeConfig(config: WorkspaceConfig): AcmeConfig | undefined {
  if (!isAcmeTls(config)) return undefined;

  const acme = config.proxy?.tls?.acme;
  if (!acme) {
    throw new TlsError(
      'proxy.tls.mode is "acme" but proxy.tls.acme is missing. ' +
        "Declare at least a DNS provider, e.g. proxy.tls.acme.provider: cloudflare.",
    );
  }
  if (!PROVIDER_NAME_PATTERN.test(acme.provider)) {
    throw new TlsError(
      `Invalid proxy.tls.acme.provider "${acme.provider}". ` +
        "Use a caddy-dns provider name such as cloudflare, route53 or digitalocean.",
    );
  }
  return acme;
}

/** Go module path for the provider's Caddy DNS plugin. */
export function providerModule(acme: AcmeConfig): string {
  return acme.module ?? `github.com/caddy-dns/${acme.provider}`;
}

/** Resolves the configured CA to an ACME directory URL. */
export function acmeDirectoryUrl(acme: AcmeConfig): string {
  return CA_DIRECTORIES[acme.ca] ?? acme.ca;
}

/**
 * Host env vars the proxy container needs. The DNS credential is passed
 * through by name so the secret never lands in a generated file.
 */
export function acmeEnvVarNames(acme: AcmeConfig): string[] {
  const names = new Set<string>(acme.env);
  if (acme.tokenEnv) names.add(acme.tokenEnv);
  return [...names];
}

/** Compose `environment` mapping that forwards host env vars by interpolation. */
export function acmeEnvironment(acme: AcmeConfig): Record<string, string> {
  return Object.fromEntries(acmeEnvVarNames(acme).map((name) => [name, `\${${name}}`]));
}

/** Fails fast when a credential the DNS provider needs is absent from the host env. */
export function verifyAcmeEnv(acme: AcmeConfig, env: NodeJS.ProcessEnv = process.env): void {
  const missing = acmeEnvVarNames(acme).filter((name) => !env[name]);
  if (missing.length === 0) return;

  throw new TlsError(
    `Missing environment variable(s) required by the "${acme.provider}" DNS provider:\n` +
      missing.map((name) => `  - ${name}`).join("\n") +
      `\nExport them in your shell or add them to a .env file in the workspace root.`,
  );
}

/**
 * Renders the per-site `tls` directive that drives Caddy's DNS-01 challenge.
 * Returned as individual lines already indented two spaces.
 */
export function renderAcmeTlsBlock(acme: AcmeConfig): string[] {
  const arg = acme.arg ?? (acme.tokenEnv ? `{env.${acme.tokenEnv}}` : "");
  const dnsLine = `    dns ${acme.provider}${arg ? ` ${arg}` : ""}`;

  const optionEntries = Object.entries(acme.options);
  const lines = ["  tls {"];
  if (optionEntries.length === 0) {
    lines.push(dnsLine);
  } else {
    lines.push(`${dnsLine} {`);
    for (const [key, value] of optionEntries) {
      lines.push(`      ${key} ${value}`);
    }
    lines.push("    }");
  }

  if (acme.resolvers.length > 0) {
    lines.push(`    resolvers ${acme.resolvers.join(" ")}`);
  }
  if (acme.propagationTimeout) {
    lines.push(`    propagation_timeout ${acme.propagationTimeout}`);
  }
  lines.push("  }");
  return lines;
}

/** Renders the Caddyfile global options block, or an empty list when not needed. */
export function renderGlobalOptions(acme: AcmeConfig | undefined): string[] {
  if (!acme) return [];

  const lines = ["{"];
  if (acme.email) lines.push(`  email ${acme.email}`);
  lines.push(`  acme_ca ${acmeDirectoryUrl(acme)}`);
  lines.push("}");
  return lines;
}

/**
 * Dockerfile that rebuilds Caddy with the provider's DNS module via xcaddy.
 * Without it the stock `caddy` image cannot solve the DNS-01 challenge.
 */
export function generateProxyDockerfile(acme: AcmeConfig): string {
  const version = acme.caddyVersion;
  return [
    "# Generated by lo1 — do not edit.",
    `FROM caddy:${version}-builder AS builder`,
    `RUN xcaddy build --with ${providerModule(acme)}`,
    "",
    `FROM caddy:${version}-alpine`,
    "COPY --from=builder /usr/bin/caddy /usr/bin/caddy",
    "",
  ].join("\n");
}

/**
 * Deterministic image tag so the custom image is rebuilt only when the
 * provider module or base Caddy version changes.
 */
export function proxyImageTag(acme: AcmeConfig): string {
  if (acme.image) return acme.image;

  const fingerprint = createHash("sha256")
    .update(`${providerModule(acme)}|${acme.caddyVersion}`)
    .digest("hex")
    .slice(0, 12);
  return `lo1-caddy-${acme.provider}:${fingerprint}`;
}

/** Writes the generated proxy Dockerfile; returns its path, or null when unused. */
export async function writeProxyDockerfile(
  acme: AcmeConfig | undefined,
  workspaceDir = ".",
): Promise<string | null> {
  if (!acme || acme.image) return null;

  const dir = join(workspaceDir, ".lo1");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, ACME_DOCKERFILE);
  await writeFile(filePath, generateProxyDockerfile(acme), "utf-8");
  debug("writeProxyDockerfile: %s", filePath);
  return filePath;
}
