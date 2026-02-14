import { describe, it, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { executeHook, HookError, type SpawnFn, type HookOutput } from "../../src/hooks/executor";

function makeSpawnFn(exitCode: number, stdoutData?: string, stderrData?: string): SpawnFn {
  return mock<SpawnFn>((_cmd, _args, _opts) => {
    const emitter = new EventEmitter();
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });

    const child = Object.assign(emitter, {
      stdout,
      stderr,
      stdin: null,
      stdio: [null, stdout, stderr] as const,
      pid: 123,
      connected: false,
      exitCode: null,
      signalCode: null,
      spawnargs: [] as string[],
      spawnfile: "",
      killed: false,
      kill: mock(() => true),
      send: mock(() => true),
      disconnect: mock(() => {}),
      unref: mock(() => child),
      ref: mock(() => child),
      [Symbol.dispose]: mock(() => {}),
      serialization: "json" as const,
    }) as unknown as ReturnType<SpawnFn>;

    setTimeout(() => {
      if (stdoutData) stdout.push(Buffer.from(stdoutData));
      if (stderrData) stderr.push(Buffer.from(stderrData));
      stdout.push(null);
      stderr.push(null);
      emitter.emit("close", exitCode);
    }, 5);

    return child;
  });
}

describe("executeHook", () => {
  it("should spawn shell with correct args and cwd", async () => {
    const spawnFn = makeSpawnFn(0);

    await executeHook("preStart", "echo hello", { cwd: "/app", env: {} }, spawnFn);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = (spawnFn as ReturnType<typeof mock>).mock.calls[0];
    expect(cmd).toBe("sh");
    expect(args).toEqual(["-c", "echo hello"]);
    expect(opts.cwd).toBe("/app");
  });

  it("should merge env vars with process.env", async () => {
    const spawnFn = makeSpawnFn(0);

    await executeHook(
      "preStart",
      "echo hello",
      { cwd: "/app", env: { CUSTOM: "value" } },
      spawnFn,
    );

    const [, , opts] = (spawnFn as ReturnType<typeof mock>).mock.calls[0];
    expect(opts.env["CUSTOM"]).toBe("value");
    // process.env vars should also be present
    expect(opts.env["PATH"]).toBeDefined();
  });

  it("should resolve on exit code 0", async () => {
    const spawnFn = makeSpawnFn(0);

    const result = await executeHook("postStart", "true", { cwd: "/app", env: {} }, spawnFn);

    expect(result.exitCode).toBe(0);
    expect(result.hookName).toBe("postStart");
  });

  it("should throw HookError on non-zero exit", async () => {
    const spawnFn = makeSpawnFn(1);

    try {
      await executeHook("preStart", "false", { cwd: "/app", env: {} }, spawnFn);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HookError);
      const hookErr = err as HookError;
      expect(hookErr.hookName).toBe("preStart");
      expect(hookErr.exitCode).toBe(1);
    }
  });

  it("should call onOutput for stdout and stderr", async () => {
    const spawnFn = makeSpawnFn(0, "out-data", "err-data");
    const outputs: HookOutput[] = [];

    await executeHook(
      "hook",
      "cmd",
      { cwd: "/app", env: {}, onOutput: (o) => outputs.push(o) },
      spawnFn,
    );

    expect(outputs.some((o) => o.stream === "stdout" && o.text === "out-data")).toBe(true);
    expect(outputs.some((o) => o.stream === "stderr" && o.text === "err-data")).toBe(true);
  });

  it("should handle spawn error", async () => {
    const spawnFn = mock<SpawnFn>((_cmd, _args, _opts) => {
      const emitter = new EventEmitter();
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });

      const child = Object.assign(emitter, {
        stdout,
        stderr,
        stdin: null,
        stdio: [null, stdout, stderr] as const,
        pid: undefined,
        connected: false,
        exitCode: null,
        signalCode: null,
        spawnargs: [] as string[],
        spawnfile: "",
        killed: false,
        kill: mock(() => true),
        send: mock(() => true),
        disconnect: mock(() => {}),
        unref: mock(() => child),
        ref: mock(() => child),
        [Symbol.dispose]: mock(() => {}),
        serialization: "json" as const,
      }) as unknown as ReturnType<SpawnFn>;

      setTimeout(() => {
        emitter.emit("error", new Error("spawn ENOENT"));
      }, 5);

      return child;
    });

    try {
      await executeHook("hook", "nonexistent", { cwd: "/app", env: {} }, spawnFn);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HookError);
      expect((err as HookError).exitCode).toBeNull();
    }
  });
});
