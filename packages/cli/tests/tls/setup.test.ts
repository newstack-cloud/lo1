import { describe, it, expect, mock, beforeEach } from "bun:test";
import { trustCaddyCa, TlsError, type ExecFn } from "../../src/tls/setup";

const execMock = mock<ExecFn>((_cmd, _args) => Promise.resolve({ stdout: "", stderr: "" }));

beforeEach(() => {
  execMock.mockClear();
  execMock.mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));
});

describe("trustCaddyCa", () => {
  it("should call docker exec caddy trust", async () => {
    await trustCaddyCa("lo1-proxy", execMock);

    expect(execMock).toHaveBeenCalledWith("docker", ["exec", "lo1-proxy", "caddy", "trust"]);
  });

  it("should use custom container name", async () => {
    await trustCaddyCa("my-proxy", execMock);

    expect(execMock).toHaveBeenCalledWith("docker", ["exec", "my-proxy", "caddy", "trust"]);
  });

  it("should throw TlsError when docker exec fails", async () => {
    execMock.mockImplementation(() => Promise.reject(new Error("container not running")));

    expect(trustCaddyCa("lo1-proxy", execMock)).rejects.toThrow(TlsError);
    expect(trustCaddyCa("lo1-proxy", execMock)).rejects.toThrow(
      /proxy container running/,
    );
  });
});
