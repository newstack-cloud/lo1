import { z } from "zod";

/**
 * Caddy-native ACME issuance using the DNS-01 challenge. The proxy image is
 * rebuilt with the matching `caddy-dns` provider module so Caddy obtains and
 * renews real certificates itself, no external ACME client involved.
 */
export const acmeConfigSchema = z.object({
  /** `caddy-dns` provider name, e.g. `cloudflare`, `route53`, `digitalocean`. */
  provider: z.string(),
  /** Full Go module path override, e.g. `github.com/caddy-dns/cloudflare@v0.2.1`. */
  module: z.string().optional(),
  /** ACME account email; recommended so the CA can send expiry warnings. */
  email: z.string().optional(),
  /** `letsencrypt`, `staging`, `zerossl`, or an ACME directory URL. */
  ca: z.string().default("letsencrypt"),
  /** Host env var holding the DNS API credential; rendered as `{env.NAME}`. */
  tokenEnv: z.string().optional(),
  /** Explicit inline argument for the `dns` directive; overrides `tokenEnv`. */
  arg: z.string().optional(),
  /** Additional host env vars to pass through to the proxy container. */
  env: z.array(z.string()).default([]),
  /** Extra key/value lines nested inside the `dns` directive block. */
  options: z.record(z.string(), z.string()).default({}),
  /** DNS resolvers used to check challenge propagation, e.g. `1.1.1.1`. */
  resolvers: z.array(z.string()).default([]),
  /** Caddy duration for propagation waiting, e.g. `5m`. */
  propagationTimeout: z.string().optional(),
  /**
   * Names ACME should cover, each optionally a wildcard such as
   * `*.local.example.com`. Sites matching a wildcard are folded into a single
   * site block so one certificate serves them all. Sites matching nothing here
   * fall back to Caddy's internal CA, which is what keeps non-public names
   * like `*.local` working alongside publicly issued certificates.
   * An empty list lets ACME cover every site.
   */
  domains: z.array(z.string()).default([]),
  /** Base Caddy image tag the provider module is built against. */
  caddyVersion: z.string().default("2"),
  /** Prebuilt image that already includes the provider module; skips the build. */
  image: z.string().optional(),
});

export type AcmeConfig = z.infer<typeof acmeConfigSchema>;

export const tlsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().default(443),
  /**
   * `internal` uses Caddy's built-in CA (trusted only on this machine).
   * `acme` has Caddy issue and renew publicly trusted certificates over
   * DNS-01, so every device on the LAN trusts the domains with no local CA.
   */
  mode: z.enum(["internal", "acme"]).default("internal"),
  acme: acmeConfigSchema.optional(),
});

export type TlsConfig = z.infer<typeof tlsConfigSchema>;

export const proxyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(80),
  tld: z.string().default("local"),
  tls: tlsConfigSchema.optional(),
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;
