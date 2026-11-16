import { describe, it, expect, mock } from "bun:test";
import {
  getWorkspaceStatus,
  formatStatus,
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
    isProcessAlive: mock(() => true),
    inspectContainer: mock(() => Promise.resolve("running")),
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
      readState: mock(() =>
        Promise.resolve(makeWorkspaceState({ services: { api: { runner: "compose" } } })),
      ),
      composePs: mock(() => Promise.resolve([makeComposeStatus({ Service: "api" })])),
      loadConfig: mock(() =>
        Promise.resolve(
          makeConfig({ api: { port: 3000, hostPort: 3001, mode: "container", command: undefined } }),
        ),
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

  it("reports a dev process that has exited, and the workspace as not healthy", async () => {
    const deps = makeDeps({ isProcessAlive: mock(() => false) });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.services[0].state).toBe("exited");
    expect(result!.healthy).toBe(false);
  });

  it("is healthy when every service runs and infrastructure is healthy", async () => {
    const result = await getWorkspaceStatus("/workspace", makeDeps());

    expect(result!.healthy).toBe(true);
    expect(result!.services[0]).toMatchObject({
      name: "api",
      state: "running",
      url: "http://api.my-platform.local",
    });
  });

  it("reports compose service health from docker compose ps", async () => {
    const deps = makeDeps({
      readState: mock(() =>
        Promise.resolve(makeWorkspaceState({ services: { worker: { runner: "compose" } } })),
      ),
      composePs: mock(() =>
        Promise.resolve([
          makeComposeStatus(),
          makeComposeStatus({ Service: "worker", Health: "unhealthy" }),
        ]),
      ),
      loadConfig: mock(() =>
        Promise.resolve(makeConfig({ worker: { mode: "container", containerImage: "w:1" } })),
      ),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.services[0].state).toBe("unhealthy");
    expect(result!.infrastructure.services).toEqual(["lo1-my-platform-proxy"]);
    expect(result!.healthy).toBe(false);
  });

  it("leaves init tasks out of services", async () => {
    const deps = makeDeps({
      readState: mock(() =>
        Promise.resolve(
          makeWorkspaceState({
            services: { api: { runner: "process", pid: 1 }, migrate: { runner: "compose" } },
          }),
        ),
      ),
      loadConfig: mock(() =>
        Promise.resolve(makeConfig({ api: {}, migrate: { initTask: true, mode: "container" } })),
      ),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.services.map((s) => s.name)).toEqual(["api"]);
  });

  it("treats infrastructure init tasks that exited 0 as healthy, and non-zero as degraded", async () => {
    const exited = (code: number) =>
      makeDeps({
        composePs: mock(() =>
          Promise.resolve([
            makeComposeStatus(),
            makeComposeStatus({ Service: "migrator", State: "exited", ExitCode: code }),
          ]),
        ),
      });

    expect((await getWorkspaceStatus("/workspace", exited(0)))!.infrastructure.state).toBe(
      "healthy",
    );
    expect((await getWorkspaceStatus("/workspace", exited(1)))!.infrastructure.state).toBe(
      "degraded",
    );
  });

  it('reports infrastructure "none" when the workspace has none, and stays healthy', async () => {
    const config = { ...makeConfig({ api: {} }), proxy: { enabled: false, port: 80, tld: "local" } };
    const deps = makeDeps({
      composePs: mock(() => Promise.resolve([])),
      loadConfig: mock(() => Promise.resolve(config)),
    });

    const result = await getWorkspaceStatus("/workspace", deps);

    expect(result!.infrastructure.state).toBe("none");
    expect(result!.healthy).toBe(true);
    expect(result!.services[0].url).toBe("http://localhost:3000");
  });
});

describe("formatStatus", () => {
  it("shows health, infrastructure and each service's state", () => {
    const text = formatStatus({
      workspace: "shop",
      healthy: false,
      infrastructure: { state: "healthy", services: ["postgres"] },
      services: [
        { name: "api", state: "running", mode: "dev", port: 3000, url: "https://api.shop.local" },
        { name: "worker", state: "exited", mode: "dev" },
      ],
    });

    expect(text).toBe(
      "Workspace: shop (not healthy)\n\n" +
        "Infrastructure: healthy\n  postgres\n\n" +
        "Services:\n" +
        "  api     running  dev:3000  https://api.shop.local\n" +
        "  worker  exited   dev\n",
    );
  });
});
