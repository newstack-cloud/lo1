import { describe, it, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { startProcess, type SpawnFn, type OutputLine } from "../../src/runner/process";

function makeSpawnFn(
  exitCode: number | null = 0,
  stdoutData?: string,
  delay = 10,
) {
  return mock<SpawnFn>((_cmd, _args, _opts) => {
    const emitter = new EventEmitter();
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });

    const child = Object.assign(emitter, {
      stdout,
      stderr,
      stdin: null,
      stdio: [null, stdout, stderr] as const,
      pid: 456,
      connected: false,
      exitCode: null,
      signalCode: null,
      spawnargs: [] as string[],
      spawnfile: "",
      killed: false,
      kill: mock((_signal?: string) => {
        setTimeout(() => emitter.emit("close", exitCode), 2);
        return true;
      }),
      send: mock(() => true),
      disconnect: mock(() => {}),
      unref: mock(() => child),
      ref: mock(() => child),
      [Symbol.dispose]: mock(() => {}),
      serialization: "json" as const,
    }) as unknown as ReturnType<SpawnFn>;

    setTimeout(() => {
      if (stdoutData) stdout.push(Buffer.from(stdoutData));
      stdout.push(null);
      stderr.push(null);
      emitter.emit("close", exitCode);
    }, delay);

    return child;
  });
}

describe("startProcess", () => {
  it("should spawn shell with command", () => {
    const spawnFn = makeSpawnFn(0, undefined, 50);

    startProcess(
      {
        serviceName: "web",
        command: "npm run dev",
        cwd: "/app",
        env: { PORT: "3000" },
      },
      spawnFn,
    );

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawnFn as ReturnType<typeof mock>).mock.calls[0];
    expect(cmd).toBe("sh");
    expect(args).toEqual(["-c", "npm run dev"]);
  });

  it("should return handle with running=true initially", () => {
    const spawnFn = makeSpawnFn(0, undefined, 100);

    const handle = startProcess(
      { serviceName: "web", command: "echo hi", cwd: "/app", env: {} },
      spawnFn,
    );

    expect(handle.serviceName).toBe("web");
    expect(handle.running).toBe(true);
  });

  it("should set running=false after exit", async () => {
    const spawnFn = makeSpawnFn(0, undefined, 5);

    const handle = startProcess(
      { serviceName: "web", command: "echo hi", cwd: "/app", env: {} },
      spawnFn,
    );

    await handle.exitPromise;
    expect(handle.running).toBe(false);
  });

  it("should call onOutput with OutputLine including service name and timestamp", async () => {
    const spawnFn = makeSpawnFn(0, "hello world", 5);
    const outputs: OutputLine[] = [];

    const handle = startProcess(
      {
        serviceName: "api",
        command: "echo hello",
        cwd: "/app",
        env: {},
        onOutput: (line) => outputs.push(line),
      },
      spawnFn,
    );

    await handle.exitPromise;

    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0].service).toBe("api");
    expect(outputs[0].stream).toBe("stdout");
    expect(outputs[0].text).toBe("hello world");
    expect(outputs[0].timestamp).toBeInstanceOf(Date);
  });

  it("should send signal to child process on stop", async () => {
    const spawnFn = makeSpawnFn(0, undefined, 500);

    const handle = startProcess(
      { serviceName: "web", command: "sleep 10", cwd: "/app", env: {} },
      spawnFn,
    );

    await handle.stop(100);

    const child = (spawnFn as ReturnType<typeof mock>).mock.results[0].value;
    expect(child.kill).toHaveBeenCalled();
  });

  it("should resolve exitPromise with exit code", async () => {
    const spawnFn = makeSpawnFn(42, undefined, 5);

    const handle = startProcess(
      { serviceName: "web", command: "exit 42", cwd: "/app", env: {} },
      spawnFn,
    );

    const code = await handle.exitPromise;
    expect(code).toBe(42);
  });

  it("should merge env with process.env", () => {
    const spawnFn = makeSpawnFn(0, undefined, 50);

    startProcess(
      { serviceName: "web", command: "echo", cwd: "/app", env: { MY_VAR: "val" } },
      spawnFn,
    );

    const [, , opts] = (spawnFn as ReturnType<typeof mock>).mock.calls[0];
    expect(opts.env["MY_VAR"]).toBe("val");
    expect(opts.env["PATH"]).toBeDefined();
  });
});
