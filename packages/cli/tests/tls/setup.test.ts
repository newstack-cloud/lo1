import { describe, it, expect, mock } from "bun:test";
import { trustCaddyCa, TlsError, type TlsDeps } from "../../src/tls/setup";

const FAKE_CERT = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n";
const FAKE_HASH = "abc123";
const DIFFERENT_HASH = "def456";

function makeDeps(overrides: Partial<TlsDeps> = {}): TlsDeps {
  return {
    exec: mock(() => Promise.resolve({ stdout: FAKE_CERT, stderr: "" })),
    readFile: mock(() => Promise.resolve(null)),
    writeFile: mock(() => Promise.resolve()),
    mkdir: mock(() => Promise.resolve()),
    hash: mock(() => FAKE_HASH),
    platform: "darwin",
    maxCertRetries: 1,
    certRetryIntervalMs: 0,
    ...overrides,
  };
}

describe("trustCaddyCa", () => {
  it("should extract cert from container via docker exec cat", async () => {
    const deps = makeDeps();

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    expect(deps.exec).toHaveBeenCalledWith("docker", [
      "exec",
      "lo1-proxy",
      "cat",
      "/data/caddy/pki/authorities/local/root.crt",
    ]);
  });

  it("should skip install when cached hash matches", async () => {
    const deps = makeDeps({
      readFile: mock(() => Promise.resolve(FAKE_HASH)),
    });

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    // Only the docker exec call to extract, no security call
    expect(deps.exec).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("should install cert when no cached hash exists", async () => {
    const deps = makeDeps();

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    expect(deps.mkdir).toHaveBeenCalled();
    // cert file + hash file
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    // docker exec (extract) + security (install)
    expect(deps.exec).toHaveBeenCalledTimes(2);
  });

  it("should install cert when cached hash differs", async () => {
    const deps = makeDeps({
      readFile: mock(() => Promise.resolve(DIFFERENT_HASH)),
    });

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    expect(deps.exec).toHaveBeenCalledTimes(2);
  });

  it("should use security add-trusted-cert on macOS", async () => {
    const deps = makeDeps({ platform: "darwin" });

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    const calls = (deps.exec as ReturnType<typeof mock>).mock.calls;
    const securityCall = calls.find((c: unknown[]) => c[0] === "security");
    expect(securityCall).toBeDefined();
    expect(securityCall![1]).toContain("add-trusted-cert");
    expect(securityCall![1]).toContain("/workspace/.lo1/caddy-root.crt");
  });

  it("should use update-ca-certificates on Linux", async () => {
    const deps = makeDeps({ platform: "linux" });

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    const calls = (deps.exec as ReturnType<typeof mock>).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cpCall = calls.find((c: any[]) => c[0] === "sudo" && c[1][0] === "cp");
    const updateCall = calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[0] === "sudo" && c[1][0] === "update-ca-certificates",
    );
    expect(cpCall).toBeDefined();
    expect(updateCall).toBeDefined();
  });

  it("should use certutil on Windows", async () => {
    const deps = makeDeps({ platform: "win32" });

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    const calls = (deps.exec as ReturnType<typeof mock>).mock.calls;
    const certutilCall = calls.find((c: unknown[]) => c[0] === "certutil");
    expect(certutilCall).toBeDefined();
    expect(certutilCall![1]).toEqual([
      "-addstore",
      "-user",
      "Root",
      "/workspace/.lo1/caddy-root.crt",
    ]);
  });

  it("should write cert file then hash file after install", async () => {
    const deps = makeDeps();

    await trustCaddyCa("lo1-proxy", "/workspace", deps);

    const writeCalls = (deps.writeFile as ReturnType<typeof mock>).mock.calls;
    expect(writeCalls[0][0]).toBe("/workspace/.lo1/caddy-root.crt");
    expect(writeCalls[0][1]).toBe(FAKE_CERT);
    expect(writeCalls[1][0]).toBe("/workspace/.lo1/caddy-root.crt.sha256");
    expect(writeCalls[1][1]).toBe(FAKE_HASH);
  });

  it("should throw TlsError when cert extraction fails", async () => {
    const deps = makeDeps({
      exec: mock(() => Promise.reject(new Error("container not running"))),
    });

    expect(trustCaddyCa("lo1-proxy", "/workspace", deps)).rejects.toThrow(TlsError);
    expect(trustCaddyCa("lo1-proxy", "/workspace", deps)).rejects.toThrow(
      /extract Caddy CA/,
    );
  });

  it("should throw TlsError when host install fails", async () => {
    let callCount = 0;
    const deps = makeDeps({
      exec: mock(() => {
        callCount++;
        if (callCount % 2 === 1) return Promise.resolve({ stdout: FAKE_CERT, stderr: "" });
        return Promise.reject(new Error("permission denied"));
      }),
    });

    expect(trustCaddyCa("lo1-proxy", "/workspace", deps)).rejects.toThrow(TlsError);
    expect(trustCaddyCa("lo1-proxy", "/workspace", deps)).rejects.toThrow(
      /host trust store/,
    );
  });
});
