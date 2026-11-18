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
    homeDir: "/home/dev",
    exists: mock(() => Promise.resolve(true)),
    listDir: mock(() => Promise.resolve([])),
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

  describe("on Linux", () => {
    type Call = [string, string[]];
    const missing = Object.assign(new Error("spawn certutil ENOENT"), { code: "ENOENT" });

    function execCalls(deps: TlsDeps): Call[] {
      return (deps.exec as ReturnType<typeof mock>).mock.calls as Call[];
    }

    function addedTo(deps: TlsDeps): string[] {
      return execCalls(deps)
        .filter(([cmd, args]) => cmd === "certutil" && args.includes("-A"))
        .map(([, args]) => args[1]);
    }

    it("should add the CA to Chrome's NSS database and each Firefox profile", async () => {
      const deps = makeDeps({
        platform: "linux",
        exists: mock((path: string) => Promise.resolve(!path.includes("snap/chromium"))),
        listDir: mock((path: string) =>
          Promise.resolve(path === "/home/dev/.mozilla/firefox" ? ["abc.default-release"] : []),
        ),
      });

      const result = await trustCaddyCa("lo1-shop-proxy", "/workspace", deps);

      expect(result.warning).toBeUndefined();
      expect(addedTo(deps)).toEqual([
        "sql:/home/dev/.pki/nssdb",
        "sql:/home/dev/.mozilla/firefox/abc.default-release",
      ]);
      const add = execCalls(deps).find(([, args]) => args.includes("-A"));
      expect(add![1]).toEqual([
        "-d",
        "sql:/home/dev/.pki/nssdb",
        "-A",
        "-t",
        "C,,",
        "-n",
        "lo1 lo1-shop-proxy",
        "-i",
        "/workspace/.lo1/caddy-root.crt",
      ]);
    });

    it("should create Chrome's NSS database when Chrome has never run", async () => {
      const deps = makeDeps({
        platform: "linux",
        exists: mock(() => Promise.resolve(false)),
      });

      await trustCaddyCa("lo1-shop-proxy", "/workspace", deps);

      const create = execCalls(deps).find(([, args]) => args.includes("-N"));
      expect(create![1]).toEqual(["-d", "sql:/home/dev/.pki/nssdb", "-N", "--empty-password"]);
      expect(addedTo(deps)).toEqual(["sql:/home/dev/.pki/nssdb"]);
    });

    it("should warn and leave the hash uncached when certutil is missing", async () => {
      const deps = makeDeps({
        platform: "linux",
        exec: mock((cmd: string) =>
          cmd === "certutil"
            ? Promise.reject(missing)
            : Promise.resolve({ stdout: FAKE_CERT, stderr: "" }),
        ),
      });

      const result = await trustCaddyCa("lo1-shop-proxy", "/workspace", deps);

      expect(result.warning).toContain("libnss3-tools");
      const written = (deps.writeFile as ReturnType<typeof mock>).mock.calls.map((c) => c[0]);
      expect(written).not.toContain("/workspace/.lo1/caddy-root.crt.sha256");
    });

    it("should reinstall when the cached hash predates browser store support", async () => {
      const deps = makeDeps({
        platform: "linux",
        readFile: mock(() => Promise.resolve(FAKE_HASH)),
      });

      await trustCaddyCa("lo1-shop-proxy", "/workspace", deps);

      const written = (deps.writeFile as ReturnType<typeof mock>).mock.calls;
      expect(written.at(-1)).toEqual(["/workspace/.lo1/caddy-root.crt.sha256", `${FAKE_HASH}+nss`]);
    });

    it("should throw TlsError when certutil fails to add the CA", async () => {
      const deps = makeDeps({
        platform: "linux",
        exec: mock((cmd: string, args: string[]) => {
          if (cmd === "certutil" && args.includes("-A")) return Promise.reject(new Error("bad db"));
          return Promise.resolve({ stdout: FAKE_CERT, stderr: "" });
        }),
      });

      expect(trustCaddyCa("lo1-shop-proxy", "/workspace", deps)).rejects.toThrow(
        /browser certificate stores/,
      );
    });
  });
});
