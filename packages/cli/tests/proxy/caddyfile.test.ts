import { describe, it, expect } from "bun:test";
import type { WorkspaceConfig } from "@lo1/sdk";
import { generateCaddyfile } from "../../src/proxy/caddyfile";

function makeConfig(
  services: Record<string, Record<string, unknown>>,
  overrides?: Record<string, unknown>,
): WorkspaceConfig {
  const svcEntries = Object.fromEntries(
    Object.entries(services).map(([name, svc]) => [
      name,
      { type: "service", path: `./${name}`, dependsOn: [], ...svc },
    ]),
  );
  return {
    version: "1",
    name: "my-app",
    services: svcEntries,
    ...overrides,
  } as unknown as WorkspaceConfig;
}

describe("generateCaddyfile", () => {
  it("should generate subdomain route for a service with a port", () => {
    const config = makeConfig({
      api: { mode: "dev", port: 3000 },
    });

    const result = generateCaddyfile(config);

    expect(result.content).toContain("api.my-app.local {");
    expect(result.content).toContain("reverse_proxy");
  });

  it("should use host.docker.internal for dev-mode services", () => {
    const config = makeConfig({
      api: { mode: "dev", port: 3000 },
    });

    const result = generateCaddyfile(config);

    expect(result.content).toContain("reverse_proxy host.docker.internal:3000");
  });

  it("should use service name for container-mode services", () => {
    const config = makeConfig({
      api: { mode: "container", containerImage: "api:1", port: 3000 },
    });

    const result = generateCaddyfile(config);

    expect(result.content).toContain("reverse_proxy api:3000");
  });

  it("should generate path-prefix routes grouped under base domain", () => {
    const config = makeConfig({
      api: { mode: "dev", port: 3000, proxy: { pathPrefix: "/api" } },
      web: { mode: "dev", port: 8080, proxy: { pathPrefix: "/app" } },
    });

    const result = generateCaddyfile(config);

    expect(result.content).toContain("my-app.local {");
    expect(result.content).toContain("handle /api/* {");
    expect(result.content).toContain("handle /app/* {");
  });

  it("should generate custom domain routes", () => {
    const config = makeConfig({
      web: { mode: "dev", port: 3000, proxy: { domain: "myapp.dev" } },
    });

    const result = generateCaddyfile(config);

    expect(result.content).toContain("myapp.dev {");
    expect(result.content).toContain("reverse_proxy host.docker.internal:3000");
  });

  it("should include tls internal directive when TLS is enabled", () => {
    const config = makeConfig(
      { api: { mode: "dev", port: 3000 } },
      {
        proxy: {
          enabled: true,
          port: 80,
          tld: "local",
          tls: { enabled: true, port: 443 },
        },
      },
    );

    const result = generateCaddyfile(config);

    expect(result.content).toContain("tls internal");
  });

  it("should exclude services without port or in skip mode", () => {
    const config = makeConfig({
      api: { mode: "dev", port: 3000 },
      worker: { mode: "skip", port: 9000 },
      logger: { mode: "dev" },
    });

    const result = generateCaddyfile(config);

    expect(result.content).toContain("api.my-app.local");
    expect(result.content).not.toContain("worker");
    expect(result.content).not.toContain("logger");
  });

  it("should return domains list matching collectDomains output", () => {
    const config = makeConfig({
      api: { mode: "dev", port: 3000 },
      web: { mode: "dev", port: 8080, proxy: { domain: "myapp.dev" } },
    });

    const result = generateCaddyfile(config);

    expect(result.domains).toContain("api.my-app.local");
    expect(result.domains).toContain("web.my-app.local");
    expect(result.domains).toContain("myapp.dev");
  });
});

const acmeTls = (acme: Record<string, unknown> = {}) => ({
  proxy: {
    enabled: true,
    port: 80,
    tld: "dev",
    tls: {
      enabled: true,
      port: 443,
      mode: "acme",
      acme: {
        provider: "cloudflare",
        tokenEnv: "CF_API_TOKEN",
        ca: "letsencrypt",
        env: [],
        options: {},
        resolvers: [],
        domains: [],
        caddyVersion: "2",
        ...acme,
      },
    },
  },
});

describe("generateCaddyfile with ACME", () => {
  it("should render a global options block with the CA directory", () => {
    const config = makeConfig({ api: { mode: "dev", port: 3000 } }, acmeTls({ email: "me@x.dev" }));

    const result = generateCaddyfile(config);

    expect(result.content).toStartWith("{\n  email me@x.dev\n");
    expect(result.content).toContain("acme_ca https://acme-v02.api.letsencrypt.org/directory");
  });

  it("should render a dns challenge block per site", () => {
    const config = makeConfig({ api: { mode: "dev", port: 3000 } }, acmeTls());

    const result = generateCaddyfile(config);

    expect(result.content).toContain("api.my-app.dev {");
    expect(result.content).toContain("dns cloudflare {env.CF_API_TOKEN}");
  });

  it("should never trust the internal CA in acme mode", () => {
    const config = makeConfig({ api: { mode: "dev", port: 3000 } }, acmeTls());

    const result = generateCaddyfile(config);

    expect(result.internalDomains).toEqual([]);
    expect(result.content).not.toContain("tls internal");
  });

  it("should fold hosts under a declared wildcard into one site", () => {
    const config = makeConfig(
      { api: { mode: "dev", port: 3000 }, web: { mode: "dev", port: 4000 } },
      acmeTls({ domains: ["*.my-app.dev"] }),
    );

    const result = generateCaddyfile(config);

    expect(result.content).toContain("*.my-app.dev {");
    expect(result.content).not.toContain("api.my-app.dev {");
    expect(result.content).toContain("@api_my_app_dev host api.my-app.dev");
    expect(result.content).toContain("@web_my_app_dev host web.my-app.dev");
  });

  it("should route requests through the host matcher in a wildcard site", () => {
    const config = makeConfig(
      { api: { mode: "dev", port: 3000 } },
      acmeTls({ domains: ["*.my-app.dev"] }),
    );

    const result = generateCaddyfile(config);

    expect(result.content).toContain("handle @api_my_app_dev {");
    expect(result.content).toContain("    reverse_proxy host.docker.internal:3000");
  });

  it("should use the internal CA for hosts outside the declared domains", () => {
    const config = makeConfig(
      { api: { mode: "dev", port: 3000, proxy: { domain: "api.local.example.com" } } },
      acmeTls({ domains: ["*.local.example.com"] }),
    );

    const result = generateCaddyfile(config);

    expect(result.content).toContain("*.local.example.com {");
    expect(result.content).toContain("api.my-app.dev {");
    expect(result.internalDomains).toEqual(["api.my-app.dev"]);
  });

  it("should not send a non-public host to ACME alongside a real domain", () => {
    const config = makeConfig(
      { api: { mode: "dev", port: 3000, proxy: { domain: "api.local.example.com" } } },
      acmeTls({ domains: ["*.local.example.com"] }),
    );

    const blocks = generateCaddyfile(config).content.split("\n\n");
    const internalBlock = blocks.find((b) => b.startsWith("api.my-app.dev {"));

    expect(internalBlock).toContain("tls internal");
    expect(internalBlock).not.toContain("dns cloudflare");
  });

  it("should still cover every host when no domains are declared", () => {
    const config = makeConfig({ api: { mode: "dev", port: 3000 } }, acmeTls());

    const result = generateCaddyfile(config);

    expect(result.internalDomains).toEqual([]);
    expect(result.content).toContain("dns cloudflare {env.CF_API_TOKEN}");
  });
});
