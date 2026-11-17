import { describe, it, expect, mock } from "bun:test";
import type { Plugin, RestartSignal, ServiceConfig, WorkspaceConfig } from "@lo1/sdk";
import { restartService, type RestartContext } from "../../src/orchestrator/restart";
import { watchPluginServices } from "../../src/orchestrator/watch";
import type { ServiceHandle } from "../../src/orchestrator/service";
import type { OrchestratorEvent } from "../../src/orchestrator/types";
import { validateRestartTargets } from "../../src/cli/commands/restart";

function service(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    type: "service",
    path: "./svc",
    mode: "dev",
    command: "run",
    dependsOn: [],
    initTask: false,
    ...overrides,
  } as ServiceConfig;
}

const config: WorkspaceConfig = {
  version: "1",
  name: "shop",
  services: {
    api: service({ port: 3000, hooks: { preStop: "./drain.sh" } }),
    seed: service({ initTask: true }),
    orders: service({ type: "celerity", mode: "container" }),
    off: service({ mode: "skip" }),
  },
};

function makeHandle(name: string, overrides: Partial<ServiceHandle> = {}): ServiceHandle {
  return {
    serviceName: name,
    type: "process",
    pid: 1,
    running: true,
    stop: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeContext(overrides: Partial<RestartContext> = {}) {
  const events: OrchestratorEvent[] = [];
  const ctx: RestartContext = {
    config,
    workspaceDir: "/ws",
    registry: { endpoints: new Map() },
    plugins: new Map(),
    pluginEnvVars: { QUEUE_URL: "x" },
    compose: { projectName: "lo1-shop", fileArgs: [], cwd: "/ws" },
    detached: true,
    emit: (e) => events.push(e),
    deps: {
      startService: mock((opts) => Promise.resolve(makeHandle(opts.serviceName, { pid: 2 }))),
      executeHook: mock((name) => Promise.resolve({ exitCode: 0, hookName: name })),
    },
    ...overrides,
  };
  return { ctx, events };
}

const statuses = (events: OrchestratorEvent[]) =>
  events.filter((e) => e.kind === "service").map((e) => (e.kind === "service" ? e.status : ""));

describe("restartService", () => {
  it("should run preStop, stop the service, then start it again detached and recreated", async () => {
    const { ctx, events } = makeContext();
    const current = makeHandle("api");

    const handle = await restartService("api", current, ctx);

    expect(statuses(events)).toEqual(["stopping", "stopped", "starting", "started"]);
    expect(ctx.deps.executeHook).toHaveBeenCalledTimes(1);
    expect(current.stop).toHaveBeenCalled();
    const opts = (ctx.deps.startService as ReturnType<typeof mock>).mock.calls[0][0];
    expect(opts).toMatchObject({ detached: true, recreate: true, pluginEnvVars: { QUEUE_URL: "x" } });
    expect(handle.pid).toBe(2);
  });

  it("should remove an exited container before starting its replacement", async () => {
    const { ctx, events } = makeContext();
    const exited = makeHandle("orders", { type: "container", running: false });

    await restartService("orders", exited, ctx);

    expect(exited.stop).toHaveBeenCalled();
    expect(ctx.deps.executeHook).not.toHaveBeenCalled();
    expect(statuses(events)).toEqual(["starting", "started"]);
  });

  it("should rerun an init task without stopping anything and report it completed", async () => {
    const { ctx, events } = makeContext();

    await restartService("seed", undefined, ctx);

    expect(statuses(events)).toEqual(["starting", "completed"]);
  });

  it("should propagate a failed start", async () => {
    const { ctx } = makeContext({
      deps: {
        startService: mock(() => Promise.reject(new Error('Init task "seed" exited with code 1'))),
        executeHook: mock((name) => Promise.resolve({ exitCode: 0, hookName: name })),
      },
    });

    await expect(restartService("seed", undefined, ctx)).rejects.toThrow("exited with code 1");
  });
});

function signalChannel() {
  const queue: RestartSignal[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const iterable: AsyncIterable<RestartSignal> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        while (queue.length === 0 && !closed) await new Promise<void>((r) => (wake = r));
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        return { done: true, value: undefined };
      },
      async return() {
        closed = true;
        wake?.();
        return { done: true, value: undefined };
      },
    }),
  };
  return {
    iterable,
    send(signal: RestartSignal) {
      queue.push(signal);
      wake?.();
    },
  };
}

describe("watchPluginServices", () => {
  it("should restart a service when its plugin signals a change and keep the new handle", async () => {
    const channel = signalChannel();
    const plugin: Plugin = { name: "celerity", watchForChanges: () => channel.iterable };
    const { ctx, events } = makeContext({ plugins: new Map([["celerity", plugin]]) });
    const handles = [makeHandle("orders", { type: "container" })];

    const watcher = watchPluginServices(handles, ctx);
    channel.send({ reason: "blueprint changed" });
    await new Promise((r) => setTimeout(r, 20));
    await watcher.stop();

    expect(events).toContainEqual({ kind: "phase", phase: "Restarting orders: blueprint changed" });
    expect(handles[0].pid).toBe(2);
  });

  it("should report a failed restart and keep watching", async () => {
    const channel = signalChannel();
    const plugin: Plugin = { name: "celerity", watchForChanges: () => channel.iterable };
    const startService = mock()
      .mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementation((opts) => Promise.resolve(makeHandle(opts.serviceName, { pid: 3 })));
    const { ctx, events } = makeContext({
      plugins: new Map([["celerity", plugin]]),
      deps: { startService, executeHook: mock((n) => Promise.resolve({ exitCode: 0, hookName: n })) },
    });
    const handles = [makeHandle("orders", { type: "container" })];

    const watcher = watchPluginServices(handles, ctx);
    channel.send({ reason: "first" });
    await new Promise((r) => setTimeout(r, 20));
    channel.send({ reason: "second" });
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();

    expect(events).toContainEqual({ kind: "error", message: 'Restarting "orders" failed: boom' });
    expect(handles[0].pid).toBe(3);
  });

  it("should let a restart under way finish before stop() resolves", async () => {
    const channel = signalChannel();
    const plugin: Plugin = { name: "celerity", watchForChanges: () => channel.iterable };
    let finishStart: () => void = () => {};
    const startService = mock(
      (opts: { serviceName: string }) =>
        new Promise<ServiceHandle>((r) => (finishStart = () => r(makeHandle(opts.serviceName, { pid: 4 })))),
    );
    const { ctx } = makeContext({
      plugins: new Map([["celerity", plugin]]),
      deps: { startService, executeHook: mock((n) => Promise.resolve({ exitCode: 0, hookName: n })) },
    });
    const handles = [makeHandle("orders", { type: "container" })];

    const watcher = watchPluginServices(handles, ctx);
    channel.send({ reason: "changed" });
    await new Promise((r) => setTimeout(r, 20));
    const stopped = watcher.stop();
    finishStart();
    await stopped;

    expect(handles[0].pid).toBe(4);
  });

  it("should run each restart exclusively and report the replacement", async () => {
    const channel = signalChannel();
    const plugin: Plugin = { name: "celerity", watchForChanges: () => channel.iterable };
    const { ctx } = makeContext({ plugins: new Map([["celerity", plugin]]) });
    const order: string[] = [];
    const runExclusive = async <T>(fn: () => Promise<T>) => {
      order.push("lock");
      const result = await fn();
      order.push("unlock");
      return result;
    };
    const onReplaced = mock(async (handle: ServiceHandle) => {
      order.push(`recorded ${handle.serviceName}:${handle.pid}`);
    });

    const watcher = watchPluginServices([makeHandle("orders", { type: "container" })], ctx, {
      runExclusive,
      onReplaced,
    });
    channel.send({ reason: "changed" });
    await new Promise((r) => setTimeout(r, 20));
    await watcher.stop();

    expect(order).toEqual(["lock", "recorded orders:2", "unlock"]);
  });

  it("should restart from the recorded process when lo1 restart replaced it", async () => {
    const channel = signalChannel();
    const plugin: Plugin = { name: "celerity", watchForChanges: () => channel.iterable };
    const { ctx } = makeContext({ plugins: new Map([["celerity", plugin]]) });
    const held = makeHandle("orders", { pid: 10 });
    const recorded = makeHandle("orders", { pid: 20 });

    const watcher = watchPluginServices([held], ctx, {
      recordedHandle: async () => recorded,
    });
    channel.send({ reason: "changed" });
    await new Promise((r) => setTimeout(r, 20));
    await watcher.stop();

    expect(recorded.stop).toHaveBeenCalled();
    expect(held.stop).not.toHaveBeenCalled();
  });

  it("should keep its own handle when the state file records the same process", async () => {
    const channel = signalChannel();
    const plugin: Plugin = { name: "celerity", watchForChanges: () => channel.iterable };
    const { ctx } = makeContext({ plugins: new Map([["celerity", plugin]]) });
    const held = makeHandle("orders", { pid: 10 });
    const recorded = makeHandle("orders", { pid: 10 });

    const watcher = watchPluginServices([held], ctx, { recordedHandle: async () => recorded });
    channel.send({ reason: "changed" });
    await new Promise((r) => setTimeout(r, 20));
    await watcher.stop();

    expect(held.stop).toHaveBeenCalled();
    expect(recorded.stop).not.toHaveBeenCalled();
  });

  it("should stop the watchers it started when a later plugin fails to set up", () => {
    const returned = mock(() => Promise.resolve({ done: true as const, value: undefined }));
    const started: AsyncIterable<RestartSignal> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: returned }),
    };
    const configWithTwo: WorkspaceConfig = {
      ...config,
      services: {
        orders: service({ type: "celerity", mode: "container" }),
        billing: service({ type: "broken", mode: "container" }),
      },
    };
    const { ctx } = makeContext({
      config: configWithTwo,
      plugins: new Map<string, Plugin>([
        ["celerity", { name: "celerity", watchForChanges: () => started }],
        [
          "broken",
          {
            name: "broken",
            watchForChanges: () => {
              throw new Error("no watcher");
            },
          },
        ],
      ]),
    });

    expect(() => watchPluginServices([], ctx)).toThrow("no watcher");
    expect(returned).toHaveBeenCalled();
  });

  it("should not watch services whose plugin has no watchForChanges", () => {
    const watch = mock(() => signalChannel().iterable);
    const { ctx } = makeContext({ plugins: new Map([["other", { name: "other", watchForChanges: watch }]]) });

    void watchPluginServices([], ctx).stop();

    expect(watch).not.toHaveBeenCalled();
  });
});

describe("validateRestartTargets", () => {
  it("should reject unknown and skip-mode services", () => {
    expect(() => validateRestartTargets(["nope"], config)).toThrow(
      'Unknown service "nope". Check the services in lo1.yaml.',
    );
    expect(() => validateRestartTargets(["off"], config)).toThrow(
      'Service "off" has mode: skip, so lo1 does not run it.',
    );
    expect(() => validateRestartTargets(["api", "seed"], config)).not.toThrow();
  });
});
