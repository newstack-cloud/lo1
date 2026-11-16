import { describe, it, expect, mock } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { startProcess } from "../../src/runner/process";
import { stopWorkspace, hydrateHandles, type StopDeps } from "../../src/orchestrator/stop";
import type { ServiceHandle } from "../../src/orchestrator/service";
import type { WorkspaceState, OrchestratorEvent } from "../../src/orchestrator/types";

const sampleState: WorkspaceState = {
  workspaceName: "my-platform",
  projectName: "lo1-my-platform",
  fileArgs: [".lo1/docker-compose.yml"],
  workspaceDir: "/workspace",
  services: {
    "users-api": { runner: "container", containerId: "abc123" },
    "web": { runner: "process", pid: 12345 },
    "db": { runner: "compose" },
  },
};

function makeDeps(overrides: Partial<StopDeps> = {}): StopDeps {
  return {
    loadConfig: mock(() =>
      Promise.resolve({
        version: "1" as const,
        name: "my-platform",
        services: {},
      }),
    ),
    composeDown: mock(() => Promise.resolve()),
    executeHook: mock((_name, _cmd, _opts) =>
      Promise.resolve({ exitCode: 0, hookName: _name }),
    ),
    readState: mock(() => Promise.resolve(sampleState)),
    removeState: mock(() => Promise.resolve()),
    exec: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
    ...overrides,
  };
}

describe("stopWorkspace", () => {
  it("should read state file on startup", async () => {
    const deps = makeDeps();

    await stopWorkspace({ workspaceDir: "/workspace" }, deps);

    expect(deps.readState).toHaveBeenCalledWith("/workspace");
  });

  it("should be a no-op when state file is missing", async () => {
    const deps = makeDeps({
      readState: mock(() => Promise.resolve(null)),
    });
    const events: OrchestratorEvent[] = [];

    await stopWorkspace(
      { workspaceDir: "/workspace", onEvent: (e) => events.push(e) },
      deps,
    );

    expect(deps.composeDown).not.toHaveBeenCalled();
    expect(deps.removeState).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "phase" && e.phase.includes("No running"))).toBe(true);
  });

  it("should call preStop workspace hook when defined", async () => {
    const deps = makeDeps({
      loadConfig: mock(() =>
        Promise.resolve({
          version: "1" as const,
          name: "my-platform",
          services: {},
          hooks: { preStop: "echo bye" },
        }),
      ),
    });

    await stopWorkspace({ workspaceDir: "/workspace" }, deps);

    expect(deps.executeHook).toHaveBeenCalledTimes(1);
    const [hookName, command] = (deps.executeHook as ReturnType<typeof mock>).mock.calls[0];
    expect(hookName).toBe("workspace:preStop");
    expect(command).toBe("echo bye");
  });

  it("should run a service's preStop hook in its directory before stopping it", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      loadConfig: mock(() =>
        Promise.resolve({
          version: "1" as const,
          name: "my-platform",
          services: {
            web: {
              type: "app",
              path: "./web",
              port: 4000,
              mode: "dev" as const,
              dependsOn: [],
              initTask: false,
              hooks: { preStop: "./drain.sh" },
            },
          },
        }),
      ),
      executeHook: mock((name, _cmd, _opts) => {
        calls.push(`hook:${name}`);
        return Promise.resolve({ exitCode: 0, hookName: name });
      }),
    });
    const handle: ServiceHandle = {
      serviceName: "web",
      type: "process",
      pid: 12345,
      running: true,
      stop: mock(async () => {
        calls.push("stop:web");
      }),
    };

    await stopWorkspace({ workspaceDir: "/workspace", handles: [handle] }, deps);

    expect(calls).toEqual(["hook:web:preStop", "stop:web"]);
    const opts = (deps.executeHook as ReturnType<typeof mock>).mock.calls[0][2];
    expect(opts.cwd).toBe(resolve("/workspace", "web"));
    expect(opts.env.LO1_SERVICE_NAME).toBe("web");
  });

  it("should keep stopping services when a preStop hook fails", async () => {
    const deps = makeDeps({
      loadConfig: mock(() =>
        Promise.resolve({
          version: "1" as const,
          name: "my-platform",
          services: {
            web: {
              type: "app",
              path: "./web",
              mode: "dev" as const,
              dependsOn: [],
              initTask: false,
              hooks: { preStop: "exit 1" },
            },
          },
        }),
      ),
      executeHook: mock(() => Promise.reject(new Error("exit 1"))),
    });
    const stop = mock(() => Promise.resolve());
    const handle: ServiceHandle = {
      serviceName: "web",
      type: "process",
      pid: 12345,
      running: true,
      stop,
    };
    const events: OrchestratorEvent[] = [];

    await stopWorkspace(
      { workspaceDir: "/workspace", handles: [handle], onEvent: (e) => events.push(e) },
      deps,
    );

    expect(stop).toHaveBeenCalled();
    expect(deps.composeDown).toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "error",
      message: 'preStop hook for "web" failed: exit 1',
    });
  });

  it("should also stop processes in the state file that it holds no handle for", async () => {
    const killCalls: number[] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0) throw new Error("ESRCH");
      killCalls.push(pid);
      return true;
    }) as typeof process.kill;

    try {
      const tracked: ServiceHandle = {
        serviceName: "api",
        type: "process",
        pid: 999,
        running: true,
        stop: mock(() => Promise.resolve()),
      };
      await stopWorkspace({ workspaceDir: "/workspace", handles: [tracked] }, makeDeps());

      expect(tracked.stop).toHaveBeenCalled();
      expect(killCalls.some((pid) => Math.abs(pid) === 12345)).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  it("should skip process handles that have already exited", async () => {
    const finished: ServiceHandle = {
      serviceName: "migrate",
      type: "process",
      pid: 777,
      running: false,
      stop: mock(() => Promise.resolve()),
    };
    const events: OrchestratorEvent[] = [];

    await stopWorkspace(
      {
        workspaceDir: "/workspace",
        handles: [finished],
        onEvent: (e) => events.push(e),
      },
      makeDeps({ readState: mock(() => Promise.resolve({ ...sampleState, services: {} })) }),
    );

    expect(finished.stop).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "service" && e.service === "migrate")).toBe(false);
  });

  it("should stop container services using containerId from state", async () => {
    const deps = makeDeps();

    await stopWorkspace({ workspaceDir: "/workspace" }, deps);

    const execCalls = (deps.exec! as ReturnType<typeof mock>).mock.calls;
    const stopCall = execCalls.find(
      (c: unknown[]) => c[0] === "docker" && (c[1] as unknown[])[0] === "stop",
    );
    expect(stopCall).toBeDefined();
    expect(stopCall?.[1]).toContain("abc123");

    const rmCall = execCalls.find(
      (c: unknown[]) => c[0] === "docker" && (c[1] as unknown[])[0] === "rm",
    );
    expect(rmCall).toBeDefined();
    expect(rmCall?.[1]).toContain("abc123");
  });

  it("should kill host process services by pid", async () => {
    const killCalls: [number, string | number][] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      // Signal 0 is the liveness check: report the process gone once signalled.
      if (signal === 0) throw new Error("ESRCH");
      killCalls.push([pid, signal ?? "SIGTERM"]);
      return true;
    }) as typeof process.kill;

    try {
      const deps = makeDeps();
      await stopWorkspace({ workspaceDir: "/workspace" }, deps);

      const pidCall = killCalls.find((c) => Math.abs(c[0]) === 12345);
      expect(pidCall).toBeDefined();
      expect(pidCall?.[1]).toBe("SIGTERM");
    } finally {
      process.kill = originalKill;
    }
  });

  it("should call composeDown with state options", async () => {
    const deps = makeDeps();

    await stopWorkspace({ workspaceDir: "/workspace" }, deps);

    expect(deps.composeDown).toHaveBeenCalledTimes(1);
    const callArgs = (deps.composeDown as ReturnType<typeof mock>).mock.calls[0][0];
    expect(callArgs.projectName).toBe("lo1-my-platform");
    expect(callArgs.fileArgs).toEqual([".lo1/docker-compose.yml"]);
  });

  it("should remove state file after shutdown", async () => {
    const deps = makeDeps();

    await stopWorkspace({ workspaceDir: "/workspace" }, deps);

    expect(deps.removeState).toHaveBeenCalledWith("/workspace");
  });

  it("should use provided in-memory handles instead of hydrating from state", async () => {
    const stopped: string[] = [];
    const handles: ServiceHandle[] = [
      {
        serviceName: "api",
        type: "process",
        pid: 9999,
        running: true,
        stop: mock(async () => { stopped.push("api"); }),
      },
      {
        serviceName: "worker",
        type: "container",
        containerId: "xyz",
        running: true,
        stop: mock(async () => { stopped.push("worker"); }),
      },
    ];
    const deps = makeDeps();

    await stopWorkspace({ workspaceDir: "/workspace", handles }, deps);

    expect(stopped).toEqual(["api", "worker"]);
    // exec should NOT be called — in-memory handles manage their own stop
    expect(deps.exec).not.toHaveBeenCalled();
  });
});

describe("hydrateHandles", () => {
  it("should create handles for each service in state", () => {
    const handles = hydrateHandles(sampleState);

    expect(handles).toHaveLength(3);
    expect(handles.map((h) => h.serviceName).sort()).toEqual(["db", "users-api", "web"]);
  });

  it("should set correct type and identifiers on hydrated handles", () => {
    const handles = hydrateHandles(sampleState);
    const byName = Object.fromEntries(handles.map((h) => [h.serviceName, h]));

    expect(byName["users-api"].type).toBe("container");
    expect(byName["users-api"].containerId).toBe("abc123");
    expect(byName["web"].type).toBe("process");
    expect(byName["web"].pid).toBe(12345);
    expect(byName["db"].type).toBe("compose");
  });

  it("should create working stop() for container handles", async () => {
    const exec = mock(() => Promise.resolve({ stdout: "", stderr: "" }));
    const handles = hydrateHandles(sampleState, exec);
    const container = handles.find((h) => h.serviceName === "users-api")!;

    await container.stop();

    const calls = exec.mock.calls;
    expect(calls.some((c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop")).toBe(true);
    expect(calls.some((c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rm")).toBe(true);
  });

  it("should create working stop() for process handles", async () => {
    const killCalls: [number, string | number][] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      // Signal 0 is the liveness check: report the process gone once signalled.
      if (signal === 0) throw new Error("ESRCH");
      killCalls.push([pid, signal ?? "SIGTERM"]);
      return true;
    }) as typeof process.kill;

    try {
      const handles = hydrateHandles(sampleState);
      const proc = handles.find((h) => h.serviceName === "web")!;

      await proc.stop();

      expect(killCalls.find((c) => Math.abs(c[0]) === 12345)).toBeDefined();
    } finally {
      process.kill = originalKill;
    }
  });

  describe("with real processes", () => {
    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    async function startDetached(command: string) {
      const dir = await mkdtemp(join(tmpdir(), "lo1-stop-"));
      const proc = startProcess({
        serviceName: "web",
        command,
        cwd: dir,
        env: {},
        logFile: join(dir, "web.log"),
      });
      await new Promise((r) => setTimeout(r, 200));
      const state: WorkspaceState = {
        ...sampleState,
        services: { web: { runner: "process", pid: proc.pid } },
      };
      return { dir, pid: proc.pid!, handle: hydrateHandles(state)[0] };
    }

    it.skipIf(platform() === "win32")("should wait for the process to exit", async () => {
      const { dir, pid, handle } = await startDetached("sleep 30");

      await handle.stop(2000);

      expect(isAlive(pid)).toBe(false);
      await rm(dir, { recursive: true, force: true });
    });

    it.skipIf(platform() === "win32")("should kill a process that ignores SIGTERM", async () => {
      const { dir, pid, handle } = await startDetached("trap '' TERM; while true; do sleep 0.1; done");

      await handle.stop(300);
      await new Promise((r) => setTimeout(r, 100));

      expect(isAlive(pid)).toBe(false);
      await rm(dir, { recursive: true, force: true });
    });
  });
});
