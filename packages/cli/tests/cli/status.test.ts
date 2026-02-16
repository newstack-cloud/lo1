import { describe, it, expect, mock } from "bun:test";
import {
  getWorkspaceStatus,
  type StatusDeps,
} from "../../src/cli/commands/status";
import type { WorkspaceState } from "../../src/orchestrator/types";
import type { ComposeServiceStatus } from "../../src/runner/compose";
import type { WorkspaceConfig, ServiceConfig } from "@lo1/sdk";

function makeWorkspaceState(
  overrides: Partial<WorkspaceState> = {},
): WorkspaceState {
  return {
    workspaceName: "my-platform",
    projectName: "lo1-my-platform",
    fileArgs: [".lo1/docker-compose.yml"],
    workspaceDir: "/workspace",
    services: {
      api: { runner: "process", pid: 12345 },
    },
    ...overrides,
  };
}

function makeConfig(
  services: Record<string, Partial<ServiceConfig>> = {},
): WorkspaceConfig {
  const svcEntries: Record<string, ServiceConfig> = {};
  for (const [name, overrides] of Object.entries(services)) {
    svcEntries[name] = {
      type: "service",
      path: `./${name}`,
      mode: "dev",
      dependsOn: [],
      command: "echo hi",
      port: 3000,
      ...overrides,
    } as ServiceConfig;
  }
  return { version: "1", name: "my-platform", services: svcEntries };
}

function makeComposeStatus(
  overrides: Partial<ComposeServiceStatus> = {},
): ComposeServiceStatus {
  return {
    Name: "lo1-my-platform-proxy-1",
    Service: "lo1-my-platform-proxy",
    State: "running",
    Health: "",
    ExitCode: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    readState: mock(() => Promise.resolve(makeWorkspaceState())),
    composePs: mock(() =>
      Promise.resolve([makeComposeStatus()]),
    ),
    loadConfig: mock(() =>
      Promise.resolve(makeConfig({ api: { port: 3000, hostPort: 3001 } })),
    ),
    ...overrides,
  };
}

describe("getWorkspaceStatus", () => {
  it("returns null when readState returns null", async () => {
    const deps = makeDeps({
      readState: mock(() => Promise.resolve(null)),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result).toBeNull();
  });

  it("returns StatusResult with services and infrastructure when workspace exists", async () => {
    const deps = makeDeps();

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result).not.toBeNull();
    expect(result!.workspace).toBe("my-platform");
    expect(result!.services).toHaveLength(1);
    expect(result!.services[0].name).toBe("api");
    expect(result!.infrastructure).toBeDefined();
    expect(result!.infrastructure.services).toContain("lo1-my-platform-proxy");
  });

  it('infrastructure.state is "healthy" when all compose services are running with healthy/empty Health', async () => {
    const deps = makeDeps({
      composePs: mock(() =>
        Promise.resolve([
          makeComposeStatus({ Service: "proxy", State: "running", Health: "" }),
          makeComposeStatus({
            Service: "postgres",
            State: "running",
            Health: "healthy",
          }),
        ]),
      ),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.infrastructure.state).toBe("healthy");
  });

  it('infrastructure.state is "degraded" when any service is unhealthy', async () => {
    const deps = makeDeps({
      composePs: mock(() =>
        Promise.resolve([
          makeComposeStatus({
            Service: "proxy",
            State: "running",
            Health: "healthy",
          }),
          makeComposeStatus({
            Service: "postgres",
            State: "running",
            Health: "unhealthy",
          }),
        ]),
      ),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.infrastructure.state).toBe("degraded");
  });

  it('infrastructure.state is "down" when no compose services found', async () => {
    const deps = makeDeps({
      composePs: mock(() => Promise.resolve([])),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.infrastructure.state).toBe("down");
  });

  it('infrastructure.state is "starting" when services have Health="starting"', async () => {
    const deps = makeDeps({
      composePs: mock(() =>
        Promise.resolve([
          makeComposeStatus({
            Service: "postgres",
            State: "running",
            Health: "starting",
          }),
        ]),
      ),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.infrastructure.state).toBe("starting");
  });

  it("services include port and hostPort from config", async () => {
    const deps = makeDeps({
      loadConfig: mock(() =>
        Promise.resolve(makeConfig({ api: { port: 3000, hostPort: 3001 } })),
      ),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    const apiService = result!.services.find((s) => s.name === "api");
    expect(apiService).toBeDefined();
    expect(apiService!.port).toBe(3000);
    expect(apiService!.hostPort).toBe(3001);
  });

  it("falls back to runner type for mode when config load fails", async () => {
    const state = makeWorkspaceState({
      services: {
        api: { runner: "container", containerId: "abc123" },
      },
    });
    const deps = makeDeps({
      readState: mock(() => Promise.resolve(state)),
      loadConfig: mock(() => Promise.reject(new Error("config not found"))),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    const apiService = result!.services.find((s) => s.name === "api");
    expect(apiService).toBeDefined();
    expect(apiService!.mode).toBe("container");
  });
});
