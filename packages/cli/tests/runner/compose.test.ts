import { describe, it, expect, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  composeUp,
  composeWait,
  composeLogs,
  composeDown,
  composePs,
  ComposeExecError,
  type ExecFn,
  type ComposeExecOptions,
  type ComposeSpawnFn,
  type ComposeLogLine,
} from "../../src/runner/compose";

const defaultOptions: ComposeExecOptions = {
  projectName: "lo1-my-platform",
  fileArgs: [".lo1/compose.generated.yaml", "services/api/compose.yaml"],
  cwd: "/workspace",
};

const execMock = mock<ExecFn>((_cmd, _args, _opts?) =>
  Promise.resolve({ stdout: "", stderr: "" }),
);

function createMockChild(exitCode = 0) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: mock(() => { }),
  });
  // Emit close on next tick so callers can attach listeners
  queueMicrotask(() => child.emit("close", exitCode));
  return child;
}

beforeEach(() => {
  execMock.mockClear();
  execMock.mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));
});

describe("composeUp", () => {
  it("should spawn docker compose with correct project and file args", async () => {
    const spawnMock = mock<ComposeSpawnFn>(() => createMockChild() as any);
    await composeUp(defaultOptions, spawnMock);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("compose");
    expect(args).toContain("-p");
    expect(args).toContain("lo1-my-platform");
    expect(args).toContain("-f");
    expect(args).toContain(".lo1/compose.generated.yaml");
    expect(args).toContain("services/api/compose.yaml");
    expect(opts?.cwd).toBe("/workspace");
  });

  it("should include up -d --build without --wait", async () => {
    const spawnMock = mock<ComposeSpawnFn>(() => createMockChild() as any);
    await composeUp(defaultOptions, spawnMock);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("up");
    expect(args).toContain("-d");
    expect(args).toContain("--build");
    expect(args).not.toContain("--wait");
  });

  it("should stream output via onOutput callback", async () => {
    const child = createMockChild();
    // Prevent auto-close so we can emit data first
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);
    const lines: { stream: string; text: string }[] = [];

    const promise = composeUp(
      { ...defaultOptions, onOutput: (line) => lines.push(line) },
      spawnMock,
    );

    child.stdout.emit("data", Buffer.from("Building api\n"));
    child.stderr.emit("data", Buffer.from("Warning: slow\n"));
    child.emit("close", 0);

    await promise;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ stream: "stdout", text: "Building api\n" });
    expect(lines[1]).toEqual({ stream: "stderr", text: "Warning: slow\n" });
  });

  it("should throw ComposeExecError on non-zero exit", async () => {
    const spawnMock = mock<ComposeSpawnFn>(() => createMockChild(1) as any);

    expect(composeUp(defaultOptions, spawnMock)).rejects.toThrow(ComposeExecError);
    expect(composeUp(defaultOptions, spawnMock)).rejects.toThrow(/exit code 1/);
  });

  it("should kill child on abort signal", async () => {
    const child = createMockChild();
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);
    const ac = new AbortController();

    const promise = composeUp({ ...defaultOptions, signal: ac.signal }, spawnMock);
    ac.abort();
    child.emit("close", null);

    expect(promise).rejects.toThrow(/aborted/);
    expect(child.kill).toHaveBeenCalled();
  });

  it("should append service names when services option is provided", async () => {
    const spawnMock = mock<ComposeSpawnFn>(() => createMockChild() as any);
    await composeUp({ ...defaultOptions, services: ["postgres", "redis"] }, spawnMock);

    const args = spawnMock.mock.calls[0][1] as string[];
    const buildIdx = args.indexOf("--build");
    expect(args[buildIdx + 1]).toBe("postgres");
    expect(args[buildIdx + 2]).toBe("redis");
  });

  it("should not append service names when services is empty", async () => {
    const spawnMock = mock<ComposeSpawnFn>(() => createMockChild() as any);
    await composeUp({ ...defaultOptions, services: [] }, spawnMock);

    const args = spawnMock.mock.calls[0][1] as string[];
    const lastArg = args[args.length - 1];
    expect(lastArg).toBe("--build");
  });
});

describe("composeDown", () => {
  it("should call docker compose down with correct args", async () => {
    await composeDown(defaultOptions, execMock);

    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toContain("compose");
    expect(args).toContain("-p");
    expect(args).toContain("lo1-my-platform");
    expect(args).toContain("down");
  });

  it("should throw ComposeExecError on failure", () => {
    execMock.mockImplementation(() => Promise.reject(new Error("compose failed")));

    expect(composeDown(defaultOptions, execMock)).rejects.toThrow(ComposeExecError);
    expect(composeDown(defaultOptions, execMock)).rejects.toThrow(/docker compose down failed/);
  });
});

describe("composeLogs", () => {
  it("should spawn docker compose logs with follow, no-color, and since 0s", () => {
    const child = createMockChild();
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);

    composeLogs(defaultOptions, () => { }, spawnMock);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("compose");
    expect(args).toContain("-p");
    expect(args).toContain("lo1-my-platform");
    expect(args).toContain("logs");
    expect(args).toContain("-f");
    expect(args).toContain("--no-color");
    expect(args).toContain("--since");
    expect(args).toContain("0s");
    expect(opts?.cwd).toBe("/workspace");
  });

  it("should parse docker compose log lines with service names", () => {
    const child = createMockChild();
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);
    const lines: ComposeLogLine[] = [];

    composeLogs(defaultOptions, (line) => lines.push(line), spawnMock);

    child.stdout.emit("data", Buffer.from("postgres-1  | database system is ready\n"));
    child.stdout.emit("data", Buffer.from("localstack-1  | Ready.\n"));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ service: "postgres", stream: "stdout", text: "database system is ready" });
    expect(lines[1]).toEqual({ service: "localstack", stream: "stdout", text: "Ready." });
  });

  it("should handle stderr output", () => {
    const child = createMockChild();
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);
    const lines: ComposeLogLine[] = [];

    composeLogs(defaultOptions, (line) => lines.push(line), spawnMock);

    child.stderr.emit("data", Buffer.from("api_migrator-1  | Running migrations...\n"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ service: "api_migrator", stream: "stderr", text: "Running migrations..." });
  });

  it("should handle partial lines across chunks", () => {
    const child = createMockChild();
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);
    const lines: ComposeLogLine[] = [];

    composeLogs(defaultOptions, (line) => lines.push(line), spawnMock);

    child.stdout.emit("data", Buffer.from("postgres-1  | partial "));
    expect(lines).toHaveLength(0);

    child.stdout.emit("data", Buffer.from("line content\n"));
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("partial line content");
  });

  it("should return a handle that kills the child process", () => {
    const child = createMockChild();
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);

    const handle = composeLogs(defaultOptions, () => { }, spawnMock);
    handle.kill();

    expect(child.kill).toHaveBeenCalled();
  });

  it("should kill child on abort signal", () => {
    const child = createMockChild();
    child.removeAllListeners("close");
    const spawnMock = mock<ComposeSpawnFn>(() => child as any);
    const ac = new AbortController();

    composeLogs({ ...defaultOptions, signal: ac.signal }, () => { }, spawnMock);
    ac.abort();

    expect(child.kill).toHaveBeenCalled();
  });
});

describe("composePs", () => {
  it("should call docker compose ps -a --format json", async () => {
    await composePs(defaultOptions, execMock);

    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toContain("ps");
    expect(args).toContain("-a");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("should parse NDJSON output", async () => {
    execMock.mockImplementation(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-proxy","Service":"proxy","State":"running","Health":"healthy","ExitCode":0}\n' +
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"","ExitCode":0}\n',
        stderr: "",
      }),
    );

    const result = await composePs(defaultOptions, execMock);

    expect(result).toHaveLength(2);
    expect(result[0].Name).toBe("lo1-proxy");
    expect(result[0].State).toBe("running");
    expect(result[1].Service).toBe("db");
  });

  it("should return empty array for empty output", async () => {
    execMock.mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));

    const result = await composePs(defaultOptions, execMock);

    expect(result).toEqual([]);
  });

  it("should pass cwd to exec", async () => {
    await composePs(defaultOptions, execMock);

    const opts = execMock.mock.calls[0][2];
    expect(opts?.cwd).toBe("/workspace");
  });

  it("should throw ComposeExecError on failure", () => {
    execMock.mockImplementation(() => Promise.reject(new Error("compose failed")));

    expect(composePs(defaultOptions, execMock)).rejects.toThrow(ComposeExecError);
  });
});

describe("composeWait", () => {
  it("should resolve when all services are running", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-proxy","Service":"proxy","State":"running","Health":"healthy","ExitCode":0}\n' +
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"","ExitCode":0}\n',
        stderr: "",
      }),
    );

    await composeWait(
      { ...defaultOptions, services: ["proxy", "db"], pollInterval: 10 },
      waitExec,
    );

    expect(waitExec).toHaveBeenCalled();
  });

  it("should resolve when one-off container exits with code 0", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"healthy","ExitCode":0}\n' +
          '{"Name":"lo1-migrator","Service":"migrator","State":"exited","Health":"","ExitCode":0}\n',
        stderr: "",
      }),
    );

    await composeWait(
      { ...defaultOptions, services: ["db", "migrator"], pollInterval: 10 },
      waitExec,
    );

    expect(waitExec).toHaveBeenCalled();
  });

  it("should throw when a service exits with non-zero code", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-migrator","Service":"migrator","State":"exited","Health":"","ExitCode":1}\n',
        stderr: "",
      }),
    );

    expect(
      composeWait(
        { ...defaultOptions, services: ["migrator"], pollInterval: 10 },
        waitExec,
      ),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("should throw when a service is unhealthy", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"unhealthy","ExitCode":0}\n',
        stderr: "",
      }),
    );

    expect(
      composeWait(
        { ...defaultOptions, services: ["db"], pollInterval: 10 },
        waitExec,
      ),
    ).rejects.toThrow(/unhealthy/);
  });

  it("should poll until services appear and become ready", async () => {
    let callCount = 0;
    const waitExec = mock<ExecFn>(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({
        stdout:
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"healthy","ExitCode":0}\n',
        stderr: "",
      });
    });

    await composeWait(
      { ...defaultOptions, services: ["db"], pollInterval: 10 },
      waitExec,
    );

    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("should timeout when services never become ready", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    expect(
      composeWait(
        { ...defaultOptions, services: ["db"], pollInterval: 10, timeout: 50 },
        waitExec,
      ),
    ).rejects.toThrow(/Timed out/);
  });

  it("should resolve immediately when services list is empty", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    await composeWait(
      { ...defaultOptions, services: [], pollInterval: 10 },
      waitExec,
    );

    expect(waitExec).not.toHaveBeenCalled();
  });

  it("should throw on abort signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    expect(
      composeWait(
        { ...defaultOptions, services: ["db"], signal: ac.signal, pollInterval: 10 },
        waitExec,
      ),
    ).rejects.toThrow(/aborted/);
  });

  it("should keep polling when health is starting", async () => {
    let callCount = 0;
    const waitExec = mock<ExecFn>(() => {
      callCount++;
      const health = callCount < 3 ? "starting" : "healthy";
      return Promise.resolve({
        stdout: `{"Name":"lo1-db","Service":"db","State":"running","Health":"${health}","ExitCode":0}\n`,
        stderr: "",
      });
    });

    await composeWait(
      { ...defaultOptions, services: ["db"], pollInterval: 10 },
      waitExec,
    );

    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("should keep polling waitForExit services until they exit", async () => {
    let callCount = 0;
    const waitExec = mock<ExecFn>(() => {
      callCount++;
      const migratorState = callCount < 3 ? "running" : "exited";
      return Promise.resolve({
        stdout:
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"healthy","ExitCode":0}\n' +
          `{"Name":"lo1-migrator","Service":"migrator","State":"${migratorState}","Health":"","ExitCode":0}\n`,
        stderr: "",
      });
    });

    await composeWait(
      {
        ...defaultOptions,
        services: ["db", "migrator"],
        waitForExit: ["migrator"],
        pollInterval: 10,
      },
      waitExec,
    );

    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("should treat running waitForExit service as not ready", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"healthy","ExitCode":0}\n' +
          '{"Name":"lo1-migrator","Service":"migrator","State":"running","Health":"","ExitCode":0}\n',
        stderr: "",
      }),
    );

    expect(
      composeWait(
        {
          ...defaultOptions,
          services: ["db", "migrator"],
          waitForExit: ["migrator"],
          pollInterval: 10,
          timeout: 50,
        },
        waitExec,
      ),
    ).rejects.toThrow(/Timed out/);
  });

  it("should throw when waitForExit service exits with non-zero code", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-migrator","Service":"migrator","State":"exited","Health":"","ExitCode":1}\n',
        stderr: "",
      }),
    );

    expect(
      composeWait(
        {
          ...defaultOptions,
          services: ["migrator"],
          waitForExit: ["migrator"],
          pollInterval: 10,
        },
        waitExec,
      ),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("should not require exit for services not in waitForExit", async () => {
    const waitExec = mock<ExecFn>(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-db","Service":"db","State":"running","Health":"","ExitCode":0}\n' +
          '{"Name":"lo1-migrator","Service":"migrator","State":"exited","Health":"","ExitCode":0}\n',
        stderr: "",
      }),
    );

    await composeWait(
      {
        ...defaultOptions,
        services: ["db", "migrator"],
        waitForExit: ["migrator"],
        pollInterval: 10,
      },
      waitExec,
    );

    expect(waitExec).toHaveBeenCalled();
  });
});
