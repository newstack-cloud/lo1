import { describe, it, expect, mock } from "bun:test";
import { startWorkspace, OrchestratorError } from "../../src/orchestrator/start";
import type { OrchestratorDeps, OrchestratorEvent, WorkspaceState } from "../../src/orchestrator/types";
import type { WorkspaceConfig, Plugin, ServiceConfig } from "@lo1/sdk";

function makeConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    version: "1",
    name: "my-platform",
    services: {
      api: {
        type: "service",
        path: "./services/api",
        port: 3000,
        mode: "dev",
        command: "npm start",
        dependsOn: [],
      },
      web: {
        type: "app",
        path: "./services/web",
        port: 4000,
        mode: "dev",
        command: "vite",
        dependsOn: ["api"],
      },
    },
    ...overrides,
  };
}

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return { name: "celerity", ...overrides };
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const config = makeConfig();
  return {
    loadConfig: mock(() => Promise.resolve(config)),
    loadPlugins: mock(() => Promise.resolve(new Map<string, Plugin>())),
    buildDag: mock(() => ({
      layers: [["api"], ["web"]],
      order: ["api", "web"],
      serviceCount: 2,
    })),
    buildEndpointRegistry: mock(() => ({
      endpoints: new Map([
        [
          "api",
          {
            name: "api",
            port: 3000,
            hostPort: 3000,
            internalUrl: "http://api:3000",
            externalUrl: "http://localhost:3000",
            proxyUrl: "http://api.my-platform.local",
            mode: "dev" as const,
          },
        ],
      ]),
    })),
    generateCompose: mock(() => ({
      yaml: "version: '3'",
      projectName: "lo1-my-platform",
      fileArgs: [".lo1/docker-compose.yml"],
      pluginEnvVars: {},
    })),
    writeComposeFile: mock(() => Promise.resolve(".lo1/docker-compose.yml")),
    generateCaddyfile: mock(() => ({
      content: "caddy config",
      domains: ["api.my-platform.local"],
    })),
    writeCaddyfile: mock(() => Promise.resolve(".lo1/Caddyfile")),
    generateHostsBlock: mock(() => "127.0.0.1 api.my-platform.local"),
    applyHosts: mock(() => Promise.resolve()),
    removeHosts: mock(() => Promise.resolve()),
    composeUp: mock(() => Promise.resolve()),
    composeDown: mock(() => Promise.resolve()),
    composePs: mock(() => Promise.resolve([])),
    startService: mock((opts) =>
      Promise.resolve({
        serviceName: opts.serviceName,
        type: "process" as const,
        running: true,
        stop: mock(() => Promise.resolve()),
      }),
    ),
    executeHook: mock((_name, _cmd, _opts) =>
      Promise.resolve({ exitCode: 0, hookName: _name }),
    ),
    trustCaddyCa: mock(() => Promise.resolve()),
    readState: mock(() => Promise.resolve(null)),
    writeState: mock(() => Promise.resolve()),
    removeState: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe("startWorkspace", () => {
  it("should load config from provided path", async () => {
    const deps = makeDeps();

    await startWorkspace({ configPath: "/my/config.yml" }, deps);

    expect(deps.loadConfig).toHaveBeenCalledWith("/my/config.yml");
  });

  it("should build DAG from config", async () => {
    const deps = makeDeps();

    await startWorkspace({}, deps);

    expect(deps.buildDag).toHaveBeenCalledTimes(1);
  });

  it("should load plugins from config declarations", async () => {
    const config = makeConfig({ plugins: { celerity: "@lo1/plugin-celerity" } });
    const deps = makeDeps({
      loadConfig: mock(() => Promise.resolve(config)),
    });

    await startWorkspace({}, deps);

    const [declarations] = (deps.loadPlugins as ReturnType<typeof mock>).mock.calls[0];
    expect(declarations).toEqual({ celerity: "@lo1/plugin-celerity" });
  });

  it("should throw on undeclared plugin type", async () => {
    const config = makeConfig({
      services: {
        api: {
          type: "celerity",
          path: "./api",
          mode: "dev",
          dependsOn: [],
        },
      },
    });
    const deps = makeDeps({
      loadConfig: mock(() => Promise.resolve(config)),
    });

    expect(startWorkspace({}, deps)).rejects.toThrow(OrchestratorError);
    expect(startWorkspace({}, deps)).rejects.toThrow("no matching plugin");
  });

  it("should call contributeCompose on each plugin", async () => {
    const config = makeConfig({
      services: {
        api: { type: "celerity", path: "./api", mode: "dev", dependsOn: [], command: "run" },
      },
      plugins: { celerity: "@lo1/plugin-celerity" },
    });
    const contributeCompose = mock(async () => ({
      services: {},
      envVars: {},
    }));
    const plugin = makePlugin({ contributeCompose });
    const deps = makeDeps({
      loadConfig: mock(() => Promise.resolve(config)),
      loadPlugins: mock(() => Promise.resolve(new Map([["celerity", plugin]]))),
      buildDag: mock(() => ({
        layers: [["api"]],
        order: ["api"],
        serviceCount: 1,
      })),
    });

    await startWorkspace({}, deps);

    expect(contributeCompose).toHaveBeenCalledTimes(1);
  });

  it("should generate and write compose file", async () => {
    const deps = makeDeps();

    await startWorkspace({}, deps);

    expect(deps.generateCompose).toHaveBeenCalledTimes(1);
    expect(deps.writeComposeFile).toHaveBeenCalledTimes(1);
  });

  it("should generate and write Caddyfile", async () => {
    const deps = makeDeps();

    await startWorkspace({}, deps);

    expect(deps.generateCaddyfile).toHaveBeenCalledTimes(1);
    expect(deps.writeCaddyfile).toHaveBeenCalledTimes(1);
  });

  it("should apply hosts entries", async () => {
    const deps = makeDeps();

    await startWorkspace({}, deps);

    expect(deps.generateHostsBlock).toHaveBeenCalledTimes(1);
    expect(deps.applyHosts).toHaveBeenCalledTimes(1);
  });

  it("should call composeUp with correct options", async () => {
    const deps = makeDeps();

    await startWorkspace({}, deps);

    const callArgs = (deps.composeUp as ReturnType<typeof mock>).mock.calls[0][0];
    expect(callArgs.projectName).toBe("lo1-my-platform");
    expect(callArgs.fileArgs).toEqual([".lo1/docker-compose.yml"]);
  });

  it("should write initial state after infra and update after services", async () => {
    const deps = makeDeps();

    await startWorkspace({}, deps);

    expect(deps.writeState).toHaveBeenCalledTimes(2);

    const initialState = (deps.writeState as ReturnType<typeof mock>).mock.calls[0][0];
    expect(initialState.workspaceName).toBe("my-platform");
    expect(initialState.projectName).toBe("lo1-my-platform");
    expect(initialState.services).toEqual({});

    const finalState = (deps.writeState as ReturnType<typeof mock>).mock.calls[1][0];
    expect(finalState.workspaceName).toBe("my-platform");
    expect(finalState.services).toHaveProperty("api");
    expect(finalState.services).toHaveProperty("web");
    expect(finalState.services.api.runner).toBe("process");
    expect(finalState.services.web.runner).toBe("process");
  });

  it("should call postInfrastructure hook when defined", async () => {
    const config = makeConfig({ hooks: { postInfrastructure: "echo infra-ready" } });
    const deps = makeDeps({
      loadConfig: mock(() => Promise.resolve(config)),
    });

    await startWorkspace({}, deps);

    const hookCalls = (deps.executeHook as ReturnType<typeof mock>).mock.calls;
    const infraHook = hookCalls.find(
      (c: unknown[]) => c[0] === "workspace:postInfrastructure",
    );
    expect(infraHook).toBeDefined();
  });

  it("should start services in DAG layer order", async () => {
    const startOrder: string[] = [];
    const deps = makeDeps({
      startService: mock((opts) => {
        startOrder.push(opts.serviceName);
        return Promise.resolve({
          serviceName: opts.serviceName,
          type: "process" as const,
          running: true,
          stop: mock(() => Promise.resolve()),
        });
      }),
    });

    const result = await startWorkspace({}, deps);

    expect(startOrder).toEqual(["api", "web"]);
    expect(result.handles).toHaveLength(2);
  });

  it("should call postSetup hook after all services started", async () => {
    const callOrder: string[] = [];
    const config = makeConfig({ hooks: { postSetup: "echo done" } });
    const deps = makeDeps({
      loadConfig: mock(() => Promise.resolve(config)),
      startService: mock((opts) => {
        callOrder.push("start");
        return Promise.resolve({
          serviceName: opts.serviceName,
          type: "process" as const,
          running: true,
          stop: mock(() => Promise.resolve()),
        });
      }),
      executeHook: mock((_name, _cmd, _opts) => {
        callOrder.push(`hook:${_name}`);
        return Promise.resolve({ exitCode: 0, hookName: _name });
      }),
    });

    await startWorkspace({}, deps);

    const setupIndex = callOrder.indexOf("hook:workspace:postSetup");
    const lastStart = callOrder.lastIndexOf("start");
    expect(setupIndex).toBeGreaterThan(lastStart);
  });

  it("should apply mode override to all services", async () => {
    const deps = makeDeps();

    await startWorkspace({ modeOverride: "container" }, deps);

    const buildDagCall = (deps.buildDag as ReturnType<typeof mock>).mock.calls[0][0];
    for (const svc of Object.values(buildDagCall.services) as ServiceConfig[]) {
      expect(svc.mode).toBe("container");
    }
  });

  it("should emit phase events for each step", async () => {
    const deps = makeDeps();
    const events: OrchestratorEvent[] = [];

    await startWorkspace({ onEvent: (e) => events.push(e) }, deps);

    const phases = events
      .filter((e): e is Extract<OrchestratorEvent, { kind: "phase" }> => e.kind === "phase")
      .map((e) => e.phase);

    expect(phases).toContain("Loading config");
    expect(phases).toContain("Starting infrastructure");
    expect(phases).toContain("Starting services");
    expect(phases).toContain("Ready");
  });

  it("should trust Caddy CA when TLS is enabled", async () => {
    const config = makeConfig({
      proxy: {
        tld: "local",
        port: 443,
        enabled: true,
        tls: {
          port: 443,
          certDir: ".",
          enabled: true
        }
      }
    });
    const deps = makeDeps({
      loadConfig: mock(() => Promise.resolve(config)),
    });

    await startWorkspace({}, deps);

    expect(deps.trustCaddyCa).toHaveBeenCalledTimes(1);
    expect(deps.trustCaddyCa).toHaveBeenCalledWith("lo1-my-platform-proxy", ".");
  });

  it("should skip TLS trust when TLS is not enabled", async () => {
    const deps = makeDeps();

    await startWorkspace({}, deps);

    expect(deps.trustCaddyCa).not.toHaveBeenCalled();
  });

  it("should skip hosts application when block is empty", async () => {
    const deps = makeDeps({
      generateHostsBlock: mock(() => ""),
    });

    await startWorkspace({}, deps);

    expect(deps.applyHosts).not.toHaveBeenCalled();
  });

  it("should clean up stale workspace before starting", async () => {
    const staleState: WorkspaceState = {
      workspaceName: "old-platform",
      projectName: "lo1-old-platform",
      fileArgs: [".lo1/docker-compose.yml"],
      workspaceDir: ".",
      services: {
        api: { runner: "process", pid: 99999 },
      },
    };
    const deps = makeDeps({
      readState: mock(() => Promise.resolve(staleState)),
    });

    await startWorkspace({}, deps);

    // composeDown called at least once for cleanup (and possibly once more for normal flow)
    const composeDownCalls = (deps.composeDown as ReturnType<typeof mock>).mock.calls;
    expect(composeDownCalls.length).toBeGreaterThanOrEqual(1);
    expect(composeDownCalls[0][0].projectName).toBe("lo1-old-platform");

    // removeState called for cleanup before normal flow writes new state
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });

  it("should skip cleanup when no stale state exists", async () => {
    const deps = makeDeps(); // readState returns null by default
    const events: OrchestratorEvent[] = [];

    await startWorkspace({ onEvent: (e) => events.push(e) }, deps);

    const phases = events
      .filter((e): e is Extract<OrchestratorEvent, { kind: "phase" }> => e.kind === "phase")
      .map((e) => e.phase);

    expect(phases).not.toContain("Cleaning up previous workspace run");
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it("should not start infrastructure when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps();

    expect(
      startWorkspace({ signal: controller.signal }, deps),
    ).rejects.toThrow(OrchestratorError);

    expect(deps.composeUp).not.toHaveBeenCalled();
  });

  it("should stop started services when aborted between layers", async () => {
    const controller = new AbortController();
    const stopMock = mock(() => Promise.resolve());
    const deps = makeDeps({
      startService: mock((opts) => {
        if (opts.serviceName === "api") controller.abort();
        return Promise.resolve({
          serviceName: opts.serviceName,
          type: "process" as const,
          running: true,
          stop: stopMock,
        });
      }),
    });

    expect(
      startWorkspace({ signal: controller.signal }, deps),
    ).rejects.toThrow(OrchestratorError);

    expect(deps.startService).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("should stop succeeded handles when one service in a layer fails", async () => {
    const config = makeConfig({
      services: {
        svcA: {
          type: "service",
          path: "./a",
          port: 3000,
          mode: "dev",
          command: "start",
          dependsOn: [],
        },
        svcB: {
          type: "service",
          path: "./b",
          port: 3001,
          mode: "dev",
          command: "start",
          dependsOn: [],
        },
      },
    });
    const stopMock = mock(() => Promise.resolve());
    const deps = makeDeps({
      loadConfig: mock(() => Promise.resolve(config)),
      buildDag: mock(() => ({
        layers: [["svcA", "svcB"]],
        order: ["svcA", "svcB"],
        serviceCount: 2,
      })),
      startService: mock((opts) => {
        if (opts.serviceName === "svcB") {
          return Promise.reject(new Error("svcB failed"));
        }
        return Promise.resolve({
          serviceName: opts.serviceName,
          type: "process" as const,
          running: true,
          stop: stopMock,
        });
      }),
    });

    expect(startWorkspace({}, deps)).rejects.toThrow("svcB failed");
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
