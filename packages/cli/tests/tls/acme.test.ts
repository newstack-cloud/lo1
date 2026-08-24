import { describe, it, expect } from "bun:test";
import type { AcmeConfig, WorkspaceConfig } from "@lo1/sdk";
import {
  acmeDirectoryUrl,
  acmeEnvironment,
  acmeEnvVarNames,
  generateProxyDockerfile,
  getAcmeConfig,
  isAcmeDomain,
  isAcmeTls,
  providerModule,
  proxyImageTag,
  renderAcmeTlsBlock,
  renderGlobalOptions,
  verifyAcmeEnv,
  wildcardFor,
} from "../../src/tls/acme";
import { TlsError } from "../../src/tls/setup";

function makeAcme(overrides: Partial<AcmeConfig> = {}): AcmeConfig {
  return {
    provider: "cloudflare",
    ca: "letsencrypt",
    env: [],
    options: {},
    resolvers: [],
    domains: [],
    caddyVersion: "2",
    ...overrides,
  };
}

function makeConfig(tls?: Record<string, unknown>): WorkspaceConfig {
  return {
    version: "1",
    name: "my-app",
    services: {},
    proxy: { enabled: true, port: 80, tld: "dev", tls },
  } as unknown as WorkspaceConfig;
}

describe("getAcmeConfig", () => {
  it("should return undefined when TLS is not in acme mode", () => {
    const config = makeConfig({ enabled: true, mode: "internal" });

    expect(isAcmeTls(config)).toBe(false);
    expect(getAcmeConfig(config)).toBeUndefined();
  });

  it("should throw when acme mode is set without an acme block", () => {
    const config = makeConfig({ enabled: true, mode: "acme" });

    expect(() => getAcmeConfig(config)).toThrow(TlsError);
  });

  it("should throw on a provider name that is not a caddy-dns module name", () => {
    const config = makeConfig({
      enabled: true,
      mode: "acme",
      acme: makeAcme({ provider: "../evil" }),
    });

    expect(() => getAcmeConfig(config)).toThrow("Invalid proxy.tls.acme.provider");
  });

  it("should return the acme config in acme mode", () => {
    const config = makeConfig({ enabled: true, mode: "acme", acme: makeAcme() });

    expect(getAcmeConfig(config)?.provider).toBe("cloudflare");
  });
});

describe("isAcmeDomain", () => {
  it("should cover every host when no domains are declared", () => {
    expect(isAcmeDomain(makeAcme(), "anything.local")).toBe(true);
  });

  it("should match an exact declared domain", () => {
    const acme = makeAcme({ domains: ["api.example.com"] });

    expect(isAcmeDomain(acme, "api.example.com")).toBe(true);
    expect(isAcmeDomain(acme, "web.example.com")).toBe(false);
  });

  it("should match one wildcard label only", () => {
    const acme = makeAcme({ domains: ["*.local.example.com"] });

    expect(isAcmeDomain(acme, "api.local.example.com")).toBe(true);
    expect(isAcmeDomain(acme, "a.b.local.example.com")).toBe(false);
    expect(isAcmeDomain(acme, "local.example.com")).toBe(false);
  });

  it("should exclude non-public hosts so they keep the internal CA", () => {
    const acme = makeAcme({ domains: ["*.local.example.com"] });

    expect(isAcmeDomain(acme, "api.my-app.local")).toBe(false);
  });

  it("should report the wildcard a host belongs under", () => {
    const acme = makeAcme({ domains: ["*.local.example.com", "shop.example.com"] });

    expect(wildcardFor(acme, "api.local.example.com")).toBe("*.local.example.com");
    expect(wildcardFor(acme, "shop.example.com")).toBeUndefined();
  });
});

describe("providerModule", () => {
  it("should derive the caddy-dns module from the provider name", () => {
    expect(providerModule(makeAcme())).toBe("github.com/caddy-dns/cloudflare");
  });

  it("should prefer an explicit module override", () => {
    const acme = makeAcme({ module: "github.com/caddy-dns/cloudflare@v0.2.1" });

    expect(providerModule(acme)).toBe("github.com/caddy-dns/cloudflare@v0.2.1");
  });
});

describe("acmeDirectoryUrl", () => {
  it("should map named CAs to directory URLs", () => {
    expect(acmeDirectoryUrl(makeAcme({ ca: "staging" }))).toContain("acme-staging-v02");
    expect(acmeDirectoryUrl(makeAcme({ ca: "letsencrypt" }))).toContain("acme-v02");
  });

  it("should pass a custom directory URL through unchanged", () => {
    const url = "https://ca.internal/acme/directory";

    expect(acmeDirectoryUrl(makeAcme({ ca: url }))).toBe(url);
  });
});

describe("acme env passthrough", () => {
  it("should include the token env var and any extras", () => {
    const acme = makeAcme({ tokenEnv: "CF_API_TOKEN", env: ["CF_ZONE_ID"] });

    expect(acmeEnvVarNames(acme).sort()).toEqual(["CF_API_TOKEN", "CF_ZONE_ID"]);
  });

  it("should render compose interpolation so secrets stay out of generated files", () => {
    const acme = makeAcme({ tokenEnv: "CF_API_TOKEN" });

    expect(acmeEnvironment(acme)).toEqual({ CF_API_TOKEN: "${CF_API_TOKEN}" });
  });

  it("should throw when a required env var is missing from the host env", () => {
    const acme = makeAcme({ tokenEnv: "CF_API_TOKEN" });

    expect(() => verifyAcmeEnv(acme, {})).toThrow("CF_API_TOKEN");
  });

  it("should pass when every required env var is present", () => {
    const acme = makeAcme({ tokenEnv: "CF_API_TOKEN" });

    expect(() => verifyAcmeEnv(acme, { CF_API_TOKEN: "secret" })).not.toThrow();
  });
});

describe("renderAcmeTlsBlock", () => {
  it("should render a dns directive with the token env reference", () => {
    const lines = renderAcmeTlsBlock(makeAcme({ tokenEnv: "CF_API_TOKEN" }));

    expect(lines).toEqual(["  tls {", "    dns cloudflare {env.CF_API_TOKEN}", "  }"]);
  });

  it("should prefer an explicit arg over the token env var", () => {
    const acme = makeAcme({ tokenEnv: "CF_API_TOKEN", arg: "{env.OTHER}" });

    expect(renderAcmeTlsBlock(acme)).toContain("    dns cloudflare {env.OTHER}");
  });

  it("should render provider options as a nested block", () => {
    const acme = makeAcme({ provider: "route53", options: { max_retries: "10" } });

    expect(renderAcmeTlsBlock(acme)).toEqual([
      "  tls {",
      "    dns route53 {",
      "      max_retries 10",
      "    }",
      "  }",
    ]);
  });

  it("should render resolvers and propagation timeout", () => {
    const acme = makeAcme({
      tokenEnv: "CF_API_TOKEN",
      resolvers: ["1.1.1.1", "8.8.8.8"],
      propagationTimeout: "5m",
    });

    const lines = renderAcmeTlsBlock(acme);

    expect(lines).toContain("    resolvers 1.1.1.1 8.8.8.8");
    expect(lines).toContain("    propagation_timeout 5m");
  });
});

describe("renderGlobalOptions", () => {
  it("should return nothing when acme is not configured", () => {
    expect(renderGlobalOptions(undefined)).toEqual([]);
  });

  it("should render the account email and CA directory", () => {
    const lines = renderGlobalOptions(makeAcme({ email: "me@example.com", ca: "staging" }));

    expect(lines[0]).toBe("{");
    expect(lines).toContain("  email me@example.com");
    expect(lines.some((line) => line.startsWith("  acme_ca https://acme-staging"))).toBe(true);
  });
});

describe("generateProxyDockerfile", () => {
  it("should build caddy with the provider module via xcaddy", () => {
    const dockerfile = generateProxyDockerfile(makeAcme());

    expect(dockerfile).toContain("FROM caddy:2-builder AS builder");
    expect(dockerfile).toContain("RUN xcaddy build --with github.com/caddy-dns/cloudflare");
    expect(dockerfile).toContain("COPY --from=builder /usr/bin/caddy /usr/bin/caddy");
  });

  it("should honour the configured base caddy version", () => {
    const dockerfile = generateProxyDockerfile(makeAcme({ caddyVersion: "2.8" }));

    expect(dockerfile).toContain("FROM caddy:2.8-builder AS builder");
  });
});

describe("proxyImageTag", () => {
  it("should be stable for the same provider and version", () => {
    expect(proxyImageTag(makeAcme())).toBe(proxyImageTag(makeAcme()));
  });

  it("should change when the base caddy version changes", () => {
    expect(proxyImageTag(makeAcme())).not.toBe(proxyImageTag(makeAcme({ caddyVersion: "2.8" })));
  });

  it("should use a prebuilt image when one is configured", () => {
    expect(proxyImageTag(makeAcme({ image: "ghcr.io/me/caddy:1" }))).toBe("ghcr.io/me/caddy:1");
  });
});
