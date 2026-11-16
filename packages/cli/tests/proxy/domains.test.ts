import { describe, it, expect } from "bun:test";
import type { WorkspaceConfig } from "@lo1/sdk";
import { collectDomains, serviceUrl } from "../../src/proxy/domains";

function makeConfig(
  services: Record<string, Record<string, unknown>>,
  overrides?: Record<string, unknown>,
): WorkspaceConfig {
  const svcEntries = Object.fromEntries(
    Object.entries(services).map(([name, svc]) => [
      name,
      { type: "service", path: `./${name}`, mode: "dev", dependsOn: [], ...svc },
    ]),
  );
  return {
    version: "1",
    name: "my-app",
    services: svcEntries,
    ...overrides,
  } as unknown as WorkspaceConfig;
}

describe("collectDomains", () => {
  it("should return subdomain for each service with a port", () => {
    const config = makeConfig({
      api: { port: 3000 },
      web: { port: 8080 },
    });

    const domains = collectDomains(config);

    expect(domains).toContain("api.my-app.local");
    expect(domains).toContain("web.my-app.local");
    expect(domains).toHaveLength(2);
  });

  it("should add base domain when pathPrefix is used", () => {
    const config = makeConfig({
      api: { port: 3000, proxy: { pathPrefix: "/api" } },
    });

    const domains = collectDomains(config);

    expect(domains).toContain("api.my-app.local");
    expect(domains).toContain("my-app.local");
    expect(domains).toHaveLength(2);
  });

  it("should include custom domain", () => {
    const config = makeConfig({
      web: { port: 3000, proxy: { domain: "myapp.dev" } },
    });

    const domains = collectDomains(config);

    expect(domains).toContain("web.my-app.local");
    expect(domains).toContain("myapp.dev");
    expect(domains).toHaveLength(2);
  });

  it("should deduplicate and exclude skip-mode and portless services", () => {
    const config = makeConfig({
      api: { port: 3000, proxy: { pathPrefix: "/api" } },
      web: { port: 8080, proxy: { pathPrefix: "/app" } },
      worker: { mode: "skip", port: 9000 },
      logger: {},
    });

    const domains = collectDomains(config);

    expect(domains).toContain("api.my-app.local");
    expect(domains).toContain("web.my-app.local");
    expect(domains).toContain("my-app.local");
    expect(domains).not.toContain("worker.my-app.local");
    expect(domains).not.toContain("logger.my-app.local");
    // api subdomain, web subdomain, base domain (deduped from two pathPrefixes)
    expect(domains).toHaveLength(3);
  });

  it("should use custom tld from proxy config", () => {
    const config = makeConfig(
      { api: { port: 3000 } },
      { proxy: { enabled: true, tld: "test", port: 80 } },
    );

    const domains = collectDomains(config);

    expect(domains).toContain("api.my-app.test");
  });
});

describe("serviceUrl", () => {
  const base = {
    version: "1" as const,
    name: "shop",
    services: {
      api: { type: "service", path: "./api", port: 3000, mode: "dev" as const, dependsOn: [], initTask: false },
      db: {
        type: "service",
        path: "./db",
        port: 5432,
        hostPort: 15432,
        mode: "container" as const,
        dependsOn: [],
        initTask: false,
      },
      worker: { type: "service", path: "./w", mode: "dev" as const, dependsOn: [], initTask: false },
    },
  };

  it("should use the proxy domain, with a non-default proxy port", () => {
    expect(serviceUrl(base, "api")).toBe("http://api.shop.local");
    expect(serviceUrl({ ...base, proxy: { enabled: true, port: 8080, tld: "test" } }, "api")).toBe(
      "http://api.shop.test:8080",
    );
  });

  it("should go straight to the host port when the proxy is disabled", () => {
    const noProxy = { ...base, proxy: { enabled: false, port: 80, tld: "local" } };
    expect(serviceUrl(noProxy, "api")).toBe("http://localhost:3000");
    expect(serviceUrl(noProxy, "db")).toBe("http://localhost:15432");
  });

  it("should have no URL for a service without a port", () => {
    expect(serviceUrl(base, "worker")).toBeUndefined();
  });
});
