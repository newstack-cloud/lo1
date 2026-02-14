import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  composeUp,
  composeDown,
  composePs,
  ComposeExecError,
  type ExecFn,
  type ComposeExecOptions,
} from "../../src/runner/compose";

const defaultOptions: ComposeExecOptions = {
  projectName: "lo1-my-platform",
  fileArgs: [".lo1/compose.generated.yaml", "services/api/compose.yaml"],
  cwd: "/workspace",
};

const execMock = mock<ExecFn>((_cmd, _args, _opts?) =>
  Promise.resolve({ stdout: "", stderr: "" }),
);

beforeEach(() => {
  execMock.mockClear();
  execMock.mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));
});

describe("composeUp", () => {
  it("should call docker compose with correct project and file args", async () => {
    await composeUp(defaultOptions, execMock);

    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execMock.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("compose");
    expect(args).toContain("-p");
    expect(args).toContain("lo1-my-platform");
    expect(args).toContain("-f");
    expect(args).toContain(".lo1/compose.generated.yaml");
    expect(args).toContain("services/api/compose.yaml");
    expect(opts?.cwd).toBe("/workspace");
  });

  it("should include up -d --wait", async () => {
    await composeUp(defaultOptions, execMock);

    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toContain("up");
    expect(args).toContain("-d");
    expect(args).toContain("--wait");
  });

  it("should throw ComposeExecError on failure", () => {
    execMock.mockImplementation(() => Promise.reject(new Error("compose failed")));

    expect(composeUp(defaultOptions, execMock)).rejects.toThrow(ComposeExecError);
    expect(composeUp(defaultOptions, execMock)).rejects.toThrow(/docker compose up failed/);
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

describe("composePs", () => {
  it("should call docker compose ps --format json", async () => {
    await composePs(defaultOptions, execMock);

    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toContain("ps");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("should parse NDJSON output", async () => {
    execMock.mockImplementation(() =>
      Promise.resolve({
        stdout:
          '{"Name":"lo1-proxy","Service":"proxy","State":"running","Health":"healthy"}\n' +
          '{"Name":"lo1-db","Service":"db","State":"running","Health":""}\n',
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
