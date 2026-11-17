import { describe, it, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";
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

  describe("with a log file (detached)", () => {
    it("should spawn in its own process group with output going to the file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lo1-proc-"));
      const spawnFn = makeSpawnFn(0);

      startProcess(
        { serviceName: "api", command: "npm start", cwd: "/tmp", env: {}, logFile: join(dir, "api.log") },
        spawnFn,
      );

      const opts = spawnFn.mock.calls[0][2];
      expect(opts.detached).toBe(true);
      expect(opts.windowsHide).toBe(true);
      expect(opts.stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
      await rm(dir, { recursive: true, force: true });
    });

    it("should unref the child when detached", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lo1-proc-"));
      const spawnFn = makeSpawnFn(0);
      const handle = startProcess(
        { serviceName: "api", command: "x", cwd: "/tmp", env: {}, logFile: join(dir, "api.log") },
        spawnFn,
      );

      handle.detach();

      const child = spawnFn.mock.results[0].value as unknown as { unref: ReturnType<typeof mock> };
      expect(child.unref).toHaveBeenCalled();
      await rm(dir, { recursive: true, force: true });
    });

    it.skipIf(platform() === "win32")("should report each line of real output separately", async () => {
      const outputs: OutputLine[] = [];
      const handle = startProcess({
        serviceName: "migrate",
        command: "printf '\\nadded 14 packages\\nmigrations applied'",
        cwd: tmpdir(),
        env: {},
        onOutput: (line) => outputs.push(line),
      });

      await handle.exitPromise;

      expect(outputs.map((o) => o.text)).toEqual(["added 14 packages", "migrations applied"]);
    });

    it.skipIf(platform() === "win32")("should write real process output to the log file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lo1-proc-"));
      const logFile = join(dir, "api.log");

      const handle = startProcess({
        serviceName: "api",
        command: "echo hello-from-api; echo oops >&2",
        cwd: dir,
        env: {},
        logFile,
      });

      expect(await handle.exitPromise).toBe(0);
      const content = await readFile(logFile, "utf-8");
      expect(content).toContain("hello-from-api");
      expect(content).toContain("oops");
      await rm(dir, { recursive: true, force: true });
    });

    it.skipIf(platform() === "win32")("should stop the whole process tree", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lo1-proc-"));
      const handle = startProcess({
        serviceName: "api",
        command: "sleep 30 & echo $! > child.pid; wait",
        cwd: dir,
        env: {},
        logFile: join(dir, "api.log"),
      });
      await new Promise((r) => setTimeout(r, 300));
      const childPid = Number.parseInt(await readFile(join(dir, "child.pid"), "utf-8"), 10);

      await handle.stop(2000);
      await new Promise((r) => setTimeout(r, 100));

      expect(() => process.kill(childPid, 0)).toThrow();
      await rm(dir, { recursive: true, force: true });
    });
  });
});
