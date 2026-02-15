import { describe, it, expect, mock } from "bun:test";
import {
  startService,
  ServiceStartError,
  type StartServiceOptions,
  type StartServiceDeps,
} from "../../src/orchestrator/service";
import type { WorkspaceConfig, Plugin, ServiceConfig } from "@lo1/sdk";
import type { EndpointRegistry } from "../../src/discovery/registry";

function makeConfig(services: Record<string, Partial<ServiceConfig>> = {}): WorkspaceConfig {
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

function makeRegistry(): EndpointRegistry {
  return {
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
  };
}

function makeDeps(overrides: Partial<StartServiceDeps> = {}): StartServiceDeps {
  return {
    startProcess: mock((_opts) => ({
      serviceName: _opts.serviceName,
      pid: 12345,
      running: true,
      stop: mock(() => Promise.resolve(0 as number | null)),
      exitPromise: new Promise<number | null>(() => {}),
    })),
    startContainer: mock((_opts) =>
      Promise.resolve({
        serviceName: _opts.serviceName,
        containerId: "abc123",
        running: true,
        stop: mock(() => Promise.resolve()),
        exitPromise: new Promise<number | null>(() => {}),
      }),
    ),
    executeHook: mock((_name, _cmd, _opts) =>
      Promise.resolve({ exitCode: 0, hookName: _name }),
    ),
    buildServiceEnv: mock(
      (_name, _svc, _config, _reg, _plugin, _mode) => ({ PORT: "3000" }),
    ),
    ...overrides,
  };
}

function makeOptions(overrides: Partial<StartServiceOptions> = {}): StartServiceOptions {
  const config = makeConfig({ api: {} });
  return {
    serviceName: "api",
    serviceConfig: config.services.api,
    config,
    plugin: undefined,
    registry: makeRegistry(),
    pluginEnvVars: {},
    workspaceDir: "/workspace",
    ...overrides,
  };
}

describe("startService", () => {
  it("should use ProcessRunner for dev-mode builtin with command", async () => {
    const deps = makeDeps();
    const options = makeOptions();

    const handle = await startService(options, deps);

    expect(handle.serviceName).toBe("api");
    expect(handle.type).toBe("process");
    expect(deps.startProcess).toHaveBeenCalledTimes(1);
  });

  it("should use ProcessRunner for frontend type", async () => {
    const config = makeConfig({ web: { type: "app", command: "vite" } });
    const deps = makeDeps();
    const options = makeOptions({
      serviceName: "web",
      serviceConfig: config.services.web,
      config,
    });

    const handle = await startService(options, deps);

    expect(handle.type).toBe("process");
  });

  it("should use ContainerRunner when plugin has configureContainer", async () => {
    const plugin: Plugin = {
      name: "celerity",
      configureContainer: mock(async (_input) => ({
        image: "celerity:latest",
        cmd: ["run"],
        envVars: {},
        binds: [],
        workingDir: "/app",
      })),
    };

    const deps = makeDeps();
    const options = makeOptions({ plugin });

    const handle = await startService(options, deps);

    expect(handle.serviceName).toBe("api");
    expect(handle.type).toBe("container");
    expect(deps.startContainer).toHaveBeenCalledTimes(1);
    expect(plugin.configureContainer).toHaveBeenCalledTimes(1);
  });

  it("should call configureContainer with correct ContainerInput", async () => {
    const configureFn = mock(async (_input) => ({
      image: "test:latest",
      cmd: ["start"],
      envVars: {},
      binds: [],
      workingDir: "/app",
    }));

    const plugin: Plugin = { name: "celerity", configureContainer: configureFn };
    const deps = makeDeps();
    const options = makeOptions({ plugin });

    await startService(options, deps);

    const input = (configureFn as ReturnType<typeof mock>).mock.calls[0][0];
    expect(input.serviceName).toBe("api");
    expect(input.networkName).toBe("lo1-my-platform_lo1");
    expect(input.mode).toBe("dev");
  });

  it("should return compose handle for container-mode with containerImage", async () => {
    const config = makeConfig({
      api: { mode: "container", containerImage: "myapp:latest", command: undefined },
    });
    const deps = makeDeps();
    const options = makeOptions({
      serviceConfig: config.services.api,
      config,
    });

    const handle = await startService(options, deps);

    expect(handle.type).toBe("compose");
    expect(handle.running).toBe(true);
    expect(deps.startProcess).not.toHaveBeenCalled();
    expect(deps.startContainer).not.toHaveBeenCalled();
  });

  it("should call preStart hook before starting runner", async () => {
    const callOrder: string[] = [];
    const config = makeConfig({
      api: { hooks: { preStart: "echo setup" } },
    });
    const deps = makeDeps({
      executeHook: mock((_name, _cmd, _opts) => {
        callOrder.push("hook");
        return Promise.resolve({ exitCode: 0, hookName: _name });
      }),
      startProcess: mock((_opts) => {
        callOrder.push("start");
        return {
          serviceName: _opts.serviceName,
          pid: 12345,
          running: true,
          stop: mock(() => Promise.resolve(0 as number | null)),
          exitPromise: new Promise<number | null>(() => {}),
        };
      }),
    });
    const options = makeOptions({ serviceConfig: config.services.api, config });

    await startService(options, deps);

    expect(callOrder).toEqual(["hook", "start"]);
  });

  it("should call postStart hook after starting runner", async () => {
    const callOrder: string[] = [];
    const config = makeConfig({
      api: { hooks: { postStart: "echo ready" } },
    });
    const deps = makeDeps({
      executeHook: mock((_name, _cmd, _opts) => {
        callOrder.push("hook");
        return Promise.resolve({ exitCode: 0, hookName: _name });
      }),
      startProcess: mock((_opts) => {
        callOrder.push("start");
        return {
          serviceName: _opts.serviceName,
          pid: 12345,
          running: true,
          stop: mock(() => Promise.resolve(0 as number | null)),
          exitPromise: new Promise<number | null>(() => {}),
        };
      }),
    });
    const options = makeOptions({ serviceConfig: config.services.api, config });

    await startService(options, deps);

    expect(callOrder).toEqual(["start", "hook"]);
  });

  it("should skip hooks when not defined", async () => {
    const deps = makeDeps();
    const options = makeOptions();

    await startService(options, deps);

    expect(deps.executeHook).not.toHaveBeenCalled();
  });

  it("should pass 'host' consumer mode for dev-mode process runner", async () => {
    const deps = makeDeps();
    const options = makeOptions();

    await startService(options, deps);

    const mode = (deps.buildServiceEnv as ReturnType<typeof mock>).mock.calls[0][5];
    expect(mode).toBe("host");
  });

  it("should pass 'container' consumer mode for plugin container runner", async () => {
    const plugin: Plugin = {
      name: "celerity",
      configureContainer: mock(async () => ({
        image: "test:latest",
        cmd: [],
        envVars: {},
        binds: [],
        workingDir: "/app",
      })),
    };

    const deps = makeDeps();
    const options = makeOptions({ plugin });

    await startService(options, deps);

    const mode = (deps.buildServiceEnv as ReturnType<typeof mock>).mock.calls[0][5];
    expect(mode).toBe("container");
  });

  it("should throw on dev-mode service with no command and no plugin", async () => {
    const config = makeConfig({ api: { command: undefined } });
    const deps = makeDeps();
    const options = makeOptions({ serviceConfig: config.services.api, config });

    await expect(startService(options, deps)).rejects.toThrow(ServiceStartError);
  });

  it("should build service env with correct arguments", async () => {
    const deps = makeDeps();
    const options = makeOptions({ pluginEnvVars: { DB_URL: "pg:5432" } });

    await startService(options, deps);

    const [name, _svc, _config, _reg, pluginEnv] = (
      deps.buildServiceEnv as ReturnType<typeof mock>
    ).mock.calls[0];
    expect(name).toBe("api");
    expect(pluginEnv).toEqual({ DB_URL: "pg:5432" });
  });
});
