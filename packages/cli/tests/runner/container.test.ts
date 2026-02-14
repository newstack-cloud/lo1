import { describe, it, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  startContainer,
  ContainerRunnerError,
  type ExecFn,
  type LogSpawnFn,
  type ContainerRunnerOptions,
} from "../../src/runner/container";
import type { OutputLine } from "../../src/runner/process";

const defaultOptions: ContainerRunnerOptions = {
  workspaceName: "my-platform",
  serviceName: "users-api",
  containerConfig: {
    image: "celerity-runtime:dev",
    cmd: ["dev"],
    envVars: { APP_ENV: "local" },
    binds: ["/host/app:/opt/app"],
    workingDir: "/opt/app",
  },
  networkName: "lo1",
  env: { LO1_SERVICE_NAME: "users-api" },
};

function makeExecFn(
  containerId = "abc123def456",
): ExecFn & ReturnType<typeof mock> {
  return mock<ExecFn>((_cmd, _args, _opts?) =>
    Promise.resolve({ stdout: `${containerId}\n`, stderr: "" }),
  );
}

function makeLogSpawnFn(stdoutData?: string): LogSpawnFn & ReturnType<typeof mock> {
  return mock<LogSpawnFn>((_cmd, _args, _opts?) => {
    const emitter = new EventEmitter();
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });

    const child = Object.assign(emitter, {
      stdout,
      stderr,
      stdin: null,
      pid: 789,
      killed: false,
      kill: mock(() => {
        emitter.emit("close", null);
        return true;
      }),
    });

    setTimeout(() => {
      if (stdoutData) stdout.push(Buffer.from(stdoutData));
    }, 5);

    return child as unknown as ReturnType<LogSpawnFn>;
  });
}

describe("startContainer", () => {
  it("should call docker run with correct image and command", async () => {
    const execFn = makeExecFn();
    const logSpawn = makeLogSpawnFn();

    await startContainer(defaultOptions, execFn, logSpawn);

    expect(execFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFn.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("run");
    expect(args).toContain("celerity-runtime:dev");
    expect(args[args.length - 1]).toBe("dev");
  });

  it("should include --name, --network, -w flags", async () => {
    const execFn = makeExecFn();
    const logSpawn = makeLogSpawnFn();

    await startContainer(defaultOptions, execFn, logSpawn);

    const args = execFn.mock.calls[0][1] as string[];
    const nameIdx = args.indexOf("--name");
    expect(args[nameIdx + 1]).toBe("lo1-my-platform-users-api");

    const netIdx = args.indexOf("--network");
    expect(args[netIdx + 1]).toBe("lo1");

    const wIdx = args.indexOf("-w");
    expect(args[wIdx + 1]).toBe("/opt/app");
  });

  it("should map binds as -v flags", async () => {
    const execFn = makeExecFn();
    const logSpawn = makeLogSpawnFn();

    await startContainer(defaultOptions, execFn, logSpawn);

    const args = execFn.mock.calls[0][1] as string[];
    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe("/host/app:/opt/app");
  });

  it("should inject env vars as -e flags", async () => {
    const execFn = makeExecFn();
    const logSpawn = makeLogSpawnFn();

    await startContainer(defaultOptions, execFn, logSpawn);

    const args = execFn.mock.calls[0][1] as string[];
    const eIndices = args.reduce<number[]>((acc, val, idx) => {
      if (val === "-e") acc.push(idx);
      return acc;
    }, []);

    const envValues = eIndices.map((i) => args[i + 1]);
    expect(envValues).toContain("APP_ENV=local");
    expect(envValues).toContain("LO1_SERVICE_NAME=users-api");
  });

  it("should return handle with containerId", async () => {
    const execFn = makeExecFn("container789");
    const logSpawn = makeLogSpawnFn();

    const handle = await startContainer(defaultOptions, execFn, logSpawn);

    expect(handle.containerId).toBe("container789");
    expect(handle.serviceName).toBe("users-api");
  });

  it("should stream logs via onOutput", async () => {
    const execFn = makeExecFn();
    const logSpawn = makeLogSpawnFn("log line 1");
    const outputs: OutputLine[] = [];

    await startContainer(
      { ...defaultOptions, onOutput: (line) => outputs.push(line) },
      execFn,
      logSpawn,
    );

    // Wait for async log streaming
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(logSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = logSpawn.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("logs");
    expect(args).toContain("-f");
  });

  it("should call docker stop and docker rm on stop", async () => {
    const execFn = makeExecFn();
    const logSpawn = makeLogSpawnFn();

    const handle = await startContainer(defaultOptions, execFn, logSpawn);
    await handle.stop();

    const calls = execFn.mock.calls;
    const stopCall = calls.find((c) => (c[1] as string[]).includes("stop"));
    expect(stopCall).toBeDefined();
    expect((stopCall![1] as string[])).toContain("lo1-my-platform-users-api");

    const rmCall = calls.find((c) => (c[1] as string[]).includes("rm"));
    expect(rmCall).toBeDefined();
    expect((rmCall![1] as string[])).toContain("lo1-my-platform-users-api");
  });

  it("should use custom timeout on stop", async () => {
    const execFn = makeExecFn();
    const logSpawn = makeLogSpawnFn();

    const handle = await startContainer(defaultOptions, execFn, logSpawn);
    await handle.stop(30000);

    const calls = execFn.mock.calls;
    const stopCall = calls.find((c) => (c[1] as string[]).includes("stop"));
    const args = stopCall![1] as string[];
    const tIdx = args.indexOf("-t");
    expect(args[tIdx + 1]).toBe("30");
  });

  it("should throw ContainerRunnerError on docker run failure", () => {
    const execFn = mock<ExecFn>(() => Promise.reject(new Error("docker failed")));
    const logSpawn = makeLogSpawnFn();

    expect(startContainer(defaultOptions, execFn, logSpawn)).rejects.toThrow(ContainerRunnerError);
    expect(startContainer(defaultOptions, execFn, logSpawn)).rejects.toThrow(
      /Failed to start container/,
    );
  });
});
