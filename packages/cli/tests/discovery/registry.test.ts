import { describe, it, expect } from "bun:test";
import {
  toEnvKey,
  buildEndpointRegistry,
  buildDiscoveryEnvVars,
  buildServiceEnv,
  translatePluginEnvVars,
} from "../../src/discovery/registry";
import type { WorkspaceConfig, ServiceConfig } from "@lo1/sdk";

function makeConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    version: "1",
    name: "my-platform",
    services: {
      "users-api": {
        type: "celerity",
        path: "./services/users-api",
        port: 8080,
        mode: "dev",
        dependsOn: [],
      },
      "orders-api": {
        type: "celerity",
        path: "./services/orders-api",
        port: 8081,
        mode: "container",
        dependsOn: [],
      },
    },
    ...overrides,
  };
}

describe("toEnvKey", () => {
  it("should convert hyphenated name to UPPER_SNAKE", () => {
    expect(toEnvKey("users-api")).toBe("USERS_API");
    expect(toEnvKey("my-cool-service")).toBe("MY_COOL_SERVICE");
    expect(toEnvKey("simple")).toBe("SIMPLE");
  });
});

describe("buildEndpointRegistry", () => {
  it("should create endpoints for services with ports", () => {
    const config = makeConfig();
    const registry = buildEndpointRegistry(config);

    expect(registry.endpoints.size).toBe(2);
    const usersEndpoint = registry.endpoints.get("users-api")!;
    expect(usersEndpoint.name).toBe("users-api");
    expect(usersEndpoint.port).toBe(8080);
    expect(usersEndpoint.internalUrl).toBe("http://users-api:8080");
    expect(usersEndpoint.externalUrl).toBe("http://localhost:8080");
  });

  it("should exclude portless services", () => {
    const config = makeConfig({
      services: {
        "no-port": {
          type: "process",
          path: "./svc",
          mode: "dev",
          dependsOn: [],
        },
        "has-port": {
          type: "process",
          path: "./svc",
          port: 3000,
          mode: "dev",
          dependsOn: [],
        },
      },
    });

    const registry = buildEndpointRegistry(config);
    expect(registry.endpoints.size).toBe(1);
    expect(registry.endpoints.has("has-port")).toBe(true);
  });

  it("should exclude skip-mode services", () => {
    const config = makeConfig({
      services: {
        skipped: {
          type: "process",
          path: "./svc",
          port: 3000,
          mode: "skip",
          dependsOn: [],
        },
      },
    });

    const registry = buildEndpointRegistry(config);
    expect(registry.endpoints.size).toBe(0);
  });

  it("should use https proxy URL when TLS enabled", () => {
    const config = makeConfig({
      proxy: { enabled: true, port: 80, tld: "local", tls: { enabled: true, port: 443, certDir: ".lo1/certs" } },
    });

    const registry = buildEndpointRegistry(config);
    const endpoint = registry.endpoints.get("users-api")!;
    expect(endpoint.proxyUrl).toBe("https://users-api.my-platform.local");
  });

  it("should use http proxy URL when TLS disabled", () => {
    const config = makeConfig();
    const registry = buildEndpointRegistry(config);
    const endpoint = registry.endpoints.get("users-api")!;
    expect(endpoint.proxyUrl).toBe("http://users-api.my-platform.local");
  });

  it("should use custom TLD", () => {
    const config = makeConfig({
      proxy: { enabled: true, port: 80, tld: "test" },
    });

    const registry = buildEndpointRegistry(config);
    const endpoint = registry.endpoints.get("users-api")!;
    expect(endpoint.proxyUrl).toBe("http://users-api.my-platform.test");
  });

  it("should default hostPort to port when not specified", () => {
    const config = makeConfig();
    const registry = buildEndpointRegistry(config);
    const endpoint = registry.endpoints.get("users-api")!;
    expect(endpoint.hostPort).toBe(8080);
    expect(endpoint.externalUrl).toBe("http://localhost:8080");
  });

  it("should use hostPort for externalUrl when specified", () => {
    const config = makeConfig({
      services: {
        db: {
          type: "process",
          path: "./services/db",
          port: 5432,
          hostPort: 15432,
          mode: "container",
          dependsOn: [],
        },
      },
    });

    const registry = buildEndpointRegistry(config);
    const endpoint = registry.endpoints.get("db")!;
    expect(endpoint.port).toBe(5432);
    expect(endpoint.hostPort).toBe(15432);
    expect(endpoint.internalUrl).toBe("http://db:5432");
    expect(endpoint.externalUrl).toBe("http://localhost:15432");
  });
});

describe("buildDiscoveryEnvVars", () => {
  it("should generate internal URLs for container consumers", () => {
    const registry = buildEndpointRegistry(makeConfig());
    const env = buildDiscoveryEnvVars(registry, "container");

    expect(env["LO1_SERVICE_USERS_API_URL"]).toBe("http://users-api:8080");
    expect(env["LO1_SERVICE_ORDERS_API_URL"]).toBe("http://orders-api:8081");
  });

  it("should generate localhost URLs for host consumers", () => {
    const registry = buildEndpointRegistry(makeConfig());
    const env = buildDiscoveryEnvVars(registry, "host");

    expect(env["LO1_SERVICE_USERS_API_URL"]).toBe("http://localhost:8080");
    expect(env["LO1_SERVICE_ORDERS_API_URL"]).toBe("http://localhost:8081");
  });

  it("should include PORT and PROXY_URL vars", () => {
    const registry = buildEndpointRegistry(makeConfig());
    const env = buildDiscoveryEnvVars(registry, "host");

    expect(env["LO1_SERVICE_USERS_API_PORT"]).toBe("8080");
    expect(env["LO1_SERVICE_USERS_API_PROXY_URL"]).toBe("http://users-api.my-platform.local");
  });

  it("should use hostPort in PORT var for host consumers", () => {
    const config = makeConfig({
      services: {
        db: {
          type: "process",
          path: "./services/db",
          port: 5432,
          hostPort: 15432,
          mode: "container",
          dependsOn: [],
        },
      },
    });
    const registry = buildEndpointRegistry(config);

    const hostEnv = buildDiscoveryEnvVars(registry, "host");
    expect(hostEnv["LO1_SERVICE_DB_PORT"]).toBe("15432");
    expect(hostEnv["LO1_SERVICE_DB_URL"]).toBe("http://localhost:15432");

    const containerEnv = buildDiscoveryEnvVars(registry, "container");
    expect(containerEnv["LO1_SERVICE_DB_PORT"]).toBe("5432");
    expect(containerEnv["LO1_SERVICE_DB_URL"]).toBe("http://db:5432");
  });
});

describe("translatePluginEnvVars", () => {
  it("should replace container hostnames with localhost for host consumers", () => {
    const registry = buildEndpointRegistry(makeConfig());
    const pluginVars = {
      DB_URL: "http://users-api:8080/db",
      OTHER: "unchanged",
    };

    const translated = translatePluginEnvVars(pluginVars, registry);
    expect(translated["DB_URL"]).toBe("http://localhost:8080/db");
    expect(translated["OTHER"]).toBe("unchanged");
  });

  it("should use hostPort when translating for host consumers", () => {
    const config = makeConfig({
      services: {
        db: {
          type: "process",
          path: "./services/db",
          port: 5432,
          hostPort: 15432,
          mode: "container",
          dependsOn: [],
        },
      },
    });
    const registry = buildEndpointRegistry(config);
    const pluginVars = {
      DATABASE_URL: "postgres://db:5432/mydb",
    };

    const translated = translatePluginEnvVars(pluginVars, registry);
    expect(translated["DATABASE_URL"]).toBe("postgres://localhost:15432/mydb");
  });
});

describe("buildServiceEnv", () => {
  it("should merge discovery + plugin + service env", () => {
    const config = makeConfig();
    const registry = buildEndpointRegistry(config);
    const service = config.services["users-api"] as ServiceConfig;

    const env = buildServiceEnv("users-api", service, config, registry, { PLUGIN_VAR: "x" }, "host");

    expect(env["LO1_SERVICE_USERS_API_URL"]).toBeDefined();
    expect(env["PLUGIN_VAR"]).toBe("x");
    expect(env["LO1_SERVICE_NAME"]).toBe("users-api");
    expect(env["LO1_WORKSPACE_NAME"]).toBe("my-platform");
  });

  it("should let service env override plugin env", () => {
    const config = makeConfig({
      services: {
        "users-api": {
          type: "celerity",
          path: "./services/users-api",
          port: 8080,
          mode: "dev",
          env: { SHARED: "service-value" },
          dependsOn: [],
        },
      },
    });
    const registry = buildEndpointRegistry(config);
    const service = config.services["users-api"] as ServiceConfig;

    const env = buildServiceEnv(
      "users-api",
      service,
      config,
      registry,
      { SHARED: "plugin-value" },
      "host",
    );

    expect(env["SHARED"]).toBe("service-value");
  });

  it("should translate plugin env vars for host consumers", () => {
    const config = makeConfig();
    const registry = buildEndpointRegistry(config);
    const service = config.services["users-api"] as ServiceConfig;

    const env = buildServiceEnv(
      "users-api",
      service,
      config,
      registry,
      { ENDPOINT: "http://orders-api:8081/v1" },
      "host",
    );

    expect(env["ENDPOINT"]).toBe("http://localhost:8081/v1");
  });

  it("should keep internal hostnames for container consumers", () => {
    const config = makeConfig();
    const registry = buildEndpointRegistry(config);
    const service = config.services["users-api"] as ServiceConfig;

    const env = buildServiceEnv(
      "users-api",
      service,
      config,
      registry,
      { ENDPOINT: "http://orders-api:8081/v1" },
      "container",
    );

    expect(env["ENDPOINT"]).toBe("http://orders-api:8081/v1");
  });
});
