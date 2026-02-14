import { describe, it, expect } from "bun:test";
import { load as parseYaml } from "js-yaml";
import type { WorkspaceConfig, ComposeContribution } from "@lo1/sdk";
import { generateCompose, ComposeError } from "../../src/compose/generate";

function makeConfig(
  services: Record<string, Record<string, unknown>>,
  overrides?: Record<string, unknown>,
): WorkspaceConfig {
  const svcEntries = Object.fromEntries(
    Object.entries(services).map(([name, svc]) => [
      name,
      { type: "process", path: `./${name}`, dependsOn: [], ...svc },
    ]),
  );
  return {
    version: "1",
    name: "test-ws",
    services: svcEntries,
    ...overrides,
  } as unknown as WorkspaceConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResult(yaml: string): any {
  return parseYaml(yaml);
}

describe("generateCompose", () => {
  it("should generate compose for a single container-mode service", () => {
    const config = makeConfig({
      api: { mode: "container", containerImage: "my-api:latest", port: 3000 },
    });

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    expect(doc.name).toBe("lo1-test-ws");
    expect(doc.services.api.image).toBe("my-api:latest");
    expect(doc.services.api.ports).toEqual(["3000:3000"]);
    expect(doc.services.api.networks).toEqual(["lo1"]);
    expect(doc.networks.lo1.driver).toBe("bridge");
    expect(result.projectName).toBe("lo1-test-ws");
  });

  it("should exclude dev-mode services from compose", () => {
    const config = makeConfig({
      api: { mode: "dev", port: 3000 },
      worker: { mode: "container", containerImage: "worker:1", port: 8080 },
    });

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    expect(doc.services.api).toBeUndefined();
    expect(doc.services.worker).toBeDefined();
  });

  it("should exclude skip-mode services from compose", () => {
    const config = makeConfig({
      api: { mode: "skip", port: 3000 },
    });

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    // Only the proxy service should be present
    expect(doc.services.api).toBeUndefined();
  });

  it("should add Caddy proxy when proxy is enabled", () => {
    const config = makeConfig({
      api: { mode: "container", containerImage: "api:1", port: 3000 },
    });

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    expect(doc.services["lo1-proxy"]).toBeDefined();
    expect(doc.services["lo1-proxy"].image).toBe("caddy:2-alpine");
    expect(doc.services["lo1-proxy"].ports).toContain("80:80");
    expect(doc.services["lo1-proxy"].restart).toBe("unless-stopped");
    expect(doc.volumes.caddy_data).toBeDefined();
  });

  it("should not add Caddy proxy when proxy is disabled", () => {
    const config = makeConfig(
      { api: { mode: "container", containerImage: "api:1", port: 3000 } },
      { proxy: { enabled: false, port: 80, tld: "local" } },
    );

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    expect(doc.services["lo1-proxy"]).toBeUndefined();
  });

  it("should include TLS port when TLS enabled", () => {
    const config = makeConfig(
      { api: { mode: "container", containerImage: "api:1", port: 3000 } },
      {
        proxy: {
          enabled: true,
          port: 80,
          tld: "local",
          tls: { enabled: true, port: 443 },
        },
      },
    );

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    expect(doc.services["lo1-proxy"].ports).toContain("443:443");
  });

  it("should merge plugin compose contributions", () => {
    const config = makeConfig({ api: { mode: "dev", port: 3000 } });
    const contributions: ComposeContribution[] = [
      {
        services: {
          dynamodb: {
            image: "amazon/dynamodb-local:latest",
            ports: ["8000:8000"],
          },
        },
        envVars: { DYNAMODB_ENDPOINT: "http://dynamodb:8000" },
      },
    ];

    const result = generateCompose(config, contributions);
    const doc = parseResult(result.yaml);

    expect(doc.services.dynamodb).toBeDefined();
    expect(doc.services.dynamodb.image).toBe("amazon/dynamodb-local:latest");
    expect(doc.services.dynamodb.networks).toEqual(["lo1"]);
    expect(result.pluginEnvVars.DYNAMODB_ENDPOINT).toBe("http://dynamodb:8000");
  });

  it("should collect file args from service compose overrides and extraCompose", () => {
    const config = makeConfig(
      {
        api: {
          mode: "container",
          containerImage: "api:1",
          port: 3000,
          compose: "docker-compose.override.yaml",
          path: "./services/api",
        },
      },
      { extraCompose: "./compose.extra.yaml" },
    );

    const result = generateCompose(config);

    expect(result.fileArgs[0]).toContain("compose.generated.yaml");
    const overridePath = result.fileArgs.find((f) => f.includes("docker-compose.override.yaml"));
    expect(overridePath).toBeDefined();
    expect(overridePath).toContain("services/api/docker-compose.override.yaml");
    expect(result.fileArgs).toContain("./compose.extra.yaml");
  });

  it("should throw ComposeError when container-mode service has no containerImage", () => {
    const config = makeConfig({
      api: { mode: "container", port: 3000 },
    });

    expect(() => generateCompose(config)).toThrow(ComposeError);
    expect(() => generateCompose(config)).toThrow(/containerImage/);
  });

  it("should include env vars from service config", () => {
    const config = makeConfig({
      api: {
        mode: "container",
        containerImage: "api:1",
        port: 3000,
        env: { NODE_ENV: "production", DB_HOST: "localhost" },
      },
    });

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    expect(doc.services.api.environment.NODE_ENV).toBe("production");
    expect(doc.services.api.environment.DB_HOST).toBe("localhost");
  });
});
