import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dump as toYaml } from "js-yaml";
import { loadWorkspaceConfig, ConfigError } from "../../src/config/loader";

const TEST_DIR = join(import.meta.dir, ".tmp-config-test");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("loadWorkspaceConfig", () => {
  it("should load a minimal valid config", async () => {
    // Arrange
    const config = {
      version: "1",
      name: "test-workspace",
      services: {
        api: { type: "service", path: "./api" },
      },
    };
    const configPath = join(TEST_DIR, "lo1.yaml");
    await writeFile(configPath, toYaml(config));

    // Act
    const result = await loadWorkspaceConfig(configPath);

    // Assert
    expect(result.name).toBe("test-workspace");
    expect(result.version).toBe("1");
    expect(result.services.api.type).toBe("service");
  });

  it("should load a full config with all optional fields", async () => {
    // Arrange
    const config = {
      version: "1",
      name: "full-workspace",
      plugins: { celerity: "@lo1/plugin-celerity" },
      repositories: {
        api: {
          url: "git@github.com:org/api.git",
          path: "./services/api",
          branch: "develop",
        },
      },
      services: {
        api: {
          type: "service",
          path: "./services/api",
          port: 3000,
          command: "npm run dev",
          mode: "dev",
          env: { NODE_ENV: "development" },
          proxy: { domain: "api.test", pathPrefix: "/api" },
          dependsOn: ["db"],
        },
        db: {
          type: "container",
          path: "./services/db",
          mode: "container",
        },
      },
    };
    const configPath = join(TEST_DIR, "lo1.yaml");
    await writeFile(configPath, toYaml(config));

    // Act
    const result = await loadWorkspaceConfig(configPath);

    // Assert
    expect(result.name).toBe("full-workspace");
    expect(result.repositories?.api.branch).toBe("develop");
    expect(result.services.api.proxy?.pathPrefix).toBe("/api");
    expect(result.services.api.dependsOn).toEqual(["db"]);
  });

  it("should apply default values", async () => {
    // Arrange
    const config = {
      version: "1",
      name: "defaults-test",
      services: {
        api: { type: "service", path: "./api" },
      },
    };
    const configPath = join(TEST_DIR, "lo1.yaml");
    await writeFile(configPath, toYaml(config));

    // Act
    const result = await loadWorkspaceConfig(configPath);

    // Assert
    expect(result.services.api.mode).toBe("dev");
    expect(result.services.api.dependsOn).toEqual([]);
  });

  it("should throw ConfigError when file does not exist", async () => {
    // Arrange
    const configPath = join(TEST_DIR, "nonexistent.yaml");

    // Act & Assert
    expect(loadWorkspaceConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it("should throw ConfigError for invalid YAML", async () => {
    // Arrange
    const configPath = join(TEST_DIR, "bad.yaml");
    await writeFile(configPath, "{{invalid: yaml: [}}");

    // Act & Assert
    expect(loadWorkspaceConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it("should throw ConfigError for schema validation failure", async () => {
    // Arrange
    const config = {
      version: "99",
      name: "bad-version",
      services: {},
    };
    const configPath = join(TEST_DIR, "invalid.yaml");
    await writeFile(configPath, toYaml(config));

    // Act & Assert
    expect(loadWorkspaceConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it("should include field path in validation error message", async () => {
    // Arrange
    const config = {
      version: "1",
      name: "bad-service",
      services: {
        api: { port: "not-a-number" },
      },
    };
    const configPath = join(TEST_DIR, "invalid-field.yaml");
    await writeFile(configPath, toYaml(config));

    // Act & Assert
    try {
      await loadWorkspaceConfig(configPath);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("services");
    }
  });
});
