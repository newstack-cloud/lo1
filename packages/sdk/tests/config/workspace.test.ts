import { describe, expect, test } from "bun:test";
import { workspaceSchema } from "../../src/config/workspace";

describe("workspaceSchema", () => {
  test("parses a minimal valid config", () => {
    const config = {
      version: "1",
      name: "my-project",
      services: {
        api: { type: "service", path: "./services/api", port: 3000 },
      },
    };

    const result = workspaceSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects missing version", () => {
    const config = {
      name: "my-project",
      services: {},
    };

    const result = workspaceSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("rejects invalid version", () => {
    const config = {
      version: "2",
      name: "my-project",
      services: {},
    };

    const result = workspaceSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("parses a full config with all optional fields", () => {
    const config = {
      version: "1",
      name: "my-project",
      plugins: { celerity: "@lo1/plugin-celerity" },
      repositories: {
        api: { url: "git@github.com:org/api.git", path: "./services/api" },
      },
      proxy: { enabled: true, tld: "test" },
      services: {
        api: {
          type: "service",
          path: "./services/api",
          port: 8080,
          command: "npm run dev",
          mode: "dev",
          env: { NODE_ENV: "development" },
          dependsOn: ["db"],
        },
      },
      extraCompose: "./docker-compose.extra.yml",
      hooks: {
        postInfrastructure: "echo done",
      },
    };

    const result = workspaceSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("parses extraCompose as object with initTaskServices", () => {
    const config = {
      version: "1",
      name: "my-project",
      services: {
        api: { type: "service", path: "./services/api", port: 3000 },
      },
      extraCompose: {
        file: "./infrastructure.compose.yaml",
        initTaskServices: ["api_migrator", "localstack_init"],
      },
    };

    const result = workspaceSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      const extra = result.data.extraCompose as { file: string; initTaskServices?: string[] };
      expect(extra.file).toBe("./infrastructure.compose.yaml");
      expect(extra.initTaskServices).toEqual(["api_migrator", "localstack_init"]);
    }
  });

  test("parses service with initTask flag", () => {
    const config = {
      version: "1",
      name: "my-project",
      services: {
        migrator: {
          type: "service",
          path: "./services/migrator",
          mode: "container",
          containerImage: "migrator:latest",
          initTask: true,
        },
      },
    };

    const result = workspaceSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.services.migrator.initTask).toBe(true);
    }
  });
});
