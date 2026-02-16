import { describe, it, expect } from "bun:test";
import { load as parseYaml, dump as toYaml } from "js-yaml";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkspaceConfig, ComposeContribution } from "@lo1/sdk";
import {
  generateCompose,
  discoverExtraComposeServices,
  extraComposeFile,
  extraComposeInitTasks,
  ComposeError,
  networkId,
  proxyServiceId,
} from "../../src/compose/generate";

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
    expect(doc.services.api.networks).toEqual([networkId("test-ws")]);
    expect(doc.networks[networkId("test-ws")].driver).toBe("bridge");
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

    expect(doc.services[proxyServiceId("test-ws")]).toBeDefined();
    expect(doc.services[proxyServiceId("test-ws")].image).toBe("caddy:2-alpine");
    expect(doc.services[proxyServiceId("test-ws")].ports).toContain("80:80");
    expect(doc.services[proxyServiceId("test-ws")].restart).toBe("unless-stopped");
    expect(doc.volumes.caddy_data).toBeDefined();
  });

  it("should not add Caddy proxy when proxy is disabled", () => {
    const config = makeConfig(
      { api: { mode: "container", containerImage: "api:1", port: 3000 } },
      { proxy: { enabled: false, port: 80, tld: "local" } },
    );

    const result = generateCompose(config);
    const doc = parseResult(result.yaml);

    expect(doc.services[proxyServiceId("test-ws")]).toBeUndefined();
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

    expect(doc.services[proxyServiceId("test-ws")].ports).toContain("443:443");
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
    expect(doc.services.dynamodb.networks).toEqual([networkId("test-ws")]);
    expect(result.pluginEnvVars.DYNAMODB_ENDPOINT).toBe("http://dynamodb:8000");
  });

  it("should collect file args from service compose overrides and extraCompose string", () => {
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
    // Per-service compose files are preprocessed into .lo1/<name>.compose.yaml
    const preprocessedPath = result.fileArgs.find((f) => f.includes("api.compose.yaml"));
    expect(preprocessedPath).toBeDefined();
    expect(preprocessedPath).toContain(".lo1/api.compose.yaml");
    expect(result.fileArgs).toContain("./compose.extra.yaml");
  });

  it("should collect file args from extraCompose object form", () => {
    const config = makeConfig(
      { api: { mode: "container", containerImage: "api:1", port: 3000 } },
      {
        extraCompose: {
          file: "./infrastructure.compose.yaml",
          initTaskServices: ["api_migrator"],
        },
      },
    );

    const result = generateCompose(config);

    expect(result.fileArgs).toContain("./infrastructure.compose.yaml");
  });

  it("should throw ComposeError when container-mode service has no containerImage", () => {
    const config = makeConfig({
      api: { mode: "container", port: 3000 },
    });

    expect(() => generateCompose(config)).toThrow(ComposeError);
    expect(() => generateCompose(config)).toThrow(/containerImage or compose file/);
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

  it("should categorize proxy as infra service", () => {
    const config = makeConfig({
      api: { mode: "container", containerImage: "api:1", port: 3000 },
    });

    const result = generateCompose(config);

    expect(result.infraServices).toContain(proxyServiceId("test-ws"));
    expect(result.appServices).toContain("api");
    expect(result.infraServices).not.toContain("api");
  });

  it("should categorize plugin contributions as infra services", () => {
    const config = makeConfig({ api: { mode: "dev", port: 3000 } });
    const contributions: ComposeContribution[] = [
      {
        services: { dynamodb: { image: "amazon/dynamodb-local:latest", ports: ["8000:8000"] } },
        envVars: {},
      },
    ];

    const result = generateCompose(config, contributions);

    expect(result.infraServices).toContain("dynamodb");
    expect(result.infraServices).toContain(proxyServiceId("test-ws"));
    expect(result.appServices).toEqual([]);
  });

  it("should categorize compose-file services as app services", () => {
    const config = makeConfig({
      api: {
        mode: "container",
        containerImage: "api:1",
        port: 3000,
        compose: "docker-compose.override.yaml",
        path: "./services/api",
      },
    });

    const result = generateCompose(config);

    // api has compose set, so it appears in appServices (via compose file path)
    // but NOT in addContainerServices (which skips services with compose)
    expect(result.appServices).toContain("api");
  });

  it("should not include proxy in infraServices when proxy is disabled", () => {
    const config = makeConfig(
      { api: { mode: "container", containerImage: "api:1", port: 3000 } },
      { proxy: { enabled: false, port: 80, tld: "local" } },
    );

    const result = generateCompose(config);

    expect(result.infraServices).toEqual([]);
    expect(result.appServices).toContain("api");
  });
});

describe("discoverExtraComposeServices", () => {
  let tempDir: string;

  it("should return service names from a compose YAML file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lo1-extra-compose-"));
    const composeContent = toYaml({
      services: {
        postgres: { image: "postgres:18" },
        localstack: { image: "localstack/localstack:4" },
        api_migrator: { build: { context: "../api" } },
      },
    });
    await writeFile(join(tempDir, "infrastructure.compose.yaml"), composeContent);

    const services = await discoverExtraComposeServices("infrastructure.compose.yaml", tempDir);

    expect(services.sort()).toEqual(["api_migrator", "localstack", "postgres"]);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should return empty array when file has no services", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lo1-extra-compose-"));
    await writeFile(join(tempDir, "empty.yaml"), "version: '3'\n");

    const services = await discoverExtraComposeServices("empty.yaml", tempDir);

    expect(services).toEqual([]);
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("extraComposeFile", () => {
  it("should return the path when extraCompose is a string", () => {
    const config = makeConfig({}, { extraCompose: "./infra.compose.yaml" });
    expect(extraComposeFile(config)).toBe("./infra.compose.yaml");
  });

  it("should return the file field when extraCompose is an object", () => {
    const config = makeConfig(
      {},
      { extraCompose: { file: "./infra.compose.yaml", initTaskServices: ["migrator"] } },
    );
    expect(extraComposeFile(config)).toBe("./infra.compose.yaml");
  });

  it("should return undefined when extraCompose is not set", () => {
    const config = makeConfig({});
    expect(extraComposeFile(config)).toBeUndefined();
  });
});

describe("extraComposeInitTasks", () => {
  it("should return empty array when extraCompose is a string", () => {
    const config = makeConfig({}, { extraCompose: "./infra.compose.yaml" });
    expect(extraComposeInitTasks(config)).toEqual([]);
  });

  it("should return initTaskServices from object form", () => {
    const config = makeConfig(
      {},
      {
        extraCompose: {
          file: "./infra.compose.yaml",
          initTaskServices: ["api_migrator", "localstack_init"],
        },
      },
    );
    expect(extraComposeInitTasks(config)).toEqual(["api_migrator", "localstack_init"]);
  });

  it("should return empty array when object form has no initTaskServices", () => {
    const config = makeConfig(
      {},
      { extraCompose: { file: "./infra.compose.yaml" } },
    );
    expect(extraComposeInitTasks(config)).toEqual([]);
  });

  it("should return empty array when extraCompose is not set", () => {
    const config = makeConfig({});
    expect(extraComposeInitTasks(config)).toEqual([]);
  });
});
