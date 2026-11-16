import { describe, it, expect } from "bun:test";
import type { WorkspaceConfig } from "@lo1/sdk";
import { runDoctor, type DoctorDeps, type ExecFn } from "../../src/doctor/checks";
import { formatDoctorReport } from "../../src/cli/commands/doctor";

const config: WorkspaceConfig = {
  version: "1",
  name: "shop",
  services: {
    api: { type: "service", path: "./api", port: 3000, mode: "dev", dependsOn: [], initTask: false },
  },
};

function makeExec(responses: Record<string, string | Error>): ExecFn {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
    if (!match) throw new Error(`unexpected command: ${key}`);
    if (match[1] instanceof Error) throw match[1];
    return { stdout: match[1], stderr: "" };
  };
}

const healthyExec = makeExec({
  "docker version": "29.5.2\n",
  "docker compose version": "2.40.0\n",
  "git --version": "git version 2.50.1\n",
});

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    exec: healthyExec,
    nodeVersion: "24.14.0",
    loadConfig: async () => config,
    configExists: async () => true,
    isWorkspaceRunning: async () => false,
    readHostsFile: async () => "127.0.0.1 localhost\n127.0.0.1 api.shop.local\n",
    probePort: async () => false,
    env: {},
    ...overrides,
  };
}

function byId(results: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  return results.filter((r) => r.id === id);
}

describe("runDoctor", () => {
  it("should pass every check on a ready machine", async () => {
    const results = await runDoctor(makeDeps());

    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["node", "ok"],
      ["docker", "ok"],
      ["compose", "ok"],
      ["git", "ok"],
      ["config", "ok"],
      ["ports", "ok"],
      ["hosts", "ok"],
    ]);
    expect(byId(results, "docker")[0].message).toBe("Docker 29.5.2");
  });

  it("should fail on an old Node.js", async () => {
    const [node] = byId(await runDoctor(makeDeps({ nodeVersion: "22.11.0" })), "node");

    expect(node.status).toBe("fail");
    expect(node.message).toBe("Node.js 22.11.0 is too old; lo1 needs 24 or later");
  });

  it("should tell a missing Docker apart from a stopped daemon", async () => {
    const missing = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    const notInstalled = await runDoctor(makeDeps({ exec: makeExec({ docker: missing, git: "git version 2" }) }));
    expect(byId(notInstalled, "docker")[0].message).toBe("Docker is not installed");

    const stopped = await runDoctor(
      makeDeps({ exec: makeExec({ docker: new Error("Cannot connect"), git: "git version 2" }) }),
    );
    expect(byId(stopped, "docker")[0].message).toBe(
      "Docker is installed, but the Docker daemon is not running",
    );
  });

  it("should fail on a port conflict with a fix naming the setting", async () => {
    const results = await runDoctor(makeDeps({ probePort: async (port) => port === 3000 }));
    const [ports] = byId(results, "ports");

    expect(ports.status).toBe("fail");
    expect(ports.message).toBe('Port 3000 is already in use, but service "api" needs it');
    expect(ports.fix).toBe(
      "Stop whatever is listening on port 3000, or change services.api.port in lo1.yaml",
    );
  });

  it("should skip port checks while the workspace is running", async () => {
    const results = await runDoctor(
      makeDeps({ isWorkspaceRunning: async () => true, probePort: async () => true }),
    );

    expect(byId(results, "ports")[0].status).toBe("ok");
  });

  it("should warn when domains are missing from the hosts file", async () => {
    const results = await runDoctor(makeDeps({ readHostsFile: async () => "127.0.0.1 localhost\n" }));

    expect(byId(results, "hosts")[0]).toMatchObject({
      status: "warn",
      message: "1 of 1 domain(s) are not in the hosts file yet",
    });
  });

  it("should warn and skip workspace checks without a lo1.yaml", async () => {
    const results = await runDoctor(
      makeDeps({ configExists: async () => false, loadConfig: async () => Promise.reject(new Error("no")) }),
    );

    expect(results.map((r) => r.id)).toEqual(["node", "docker", "compose", "git", "config"]);
    expect(byId(results, "config")[0].status).toBe("warn");
  });

  it("should fail when ACME credentials are missing", async () => {
    const acmeConfig: WorkspaceConfig = {
      ...config,
      proxy: {
        enabled: true,
        port: 80,
        tld: "dev",
        tls: {
          enabled: true,
          port: 443,
          mode: "acme",
          acme: {
            provider: "cloudflare",
            tokenEnv: "CF_API_TOKEN",
            ca: "letsencrypt",
            env: [],
            options: {},
            resolvers: [],
            domains: [],
            caddyVersion: "2",
          },
        },
      },
    };
    const results = await runDoctor(makeDeps({ loadConfig: async () => acmeConfig }));

    expect(byId(results, "acme")[0].status).toBe("fail");
  });
});

describe("formatDoctorReport", () => {
  it("should list each check with its fix and a summary", () => {
    const report = formatDoctorReport(
      [
        { id: "node", status: "ok", message: "Node.js 24.14.0" },
        { id: "ports", status: "fail", message: "Port 80 is in use", fix: "Stop it" },
        { id: "hosts", status: "warn", message: "Hosts missing", fix: "Run lo1 up" },
      ],
      false,
    );

    expect(report).toBe(
      "  ✓ Node.js 24.14.0\n" +
        "  ✗ Port 80 is in use\n      Stop it\n" +
        "  ! Hosts missing\n      Run lo1 up\n\n" +
        "  1 problem, 1 warning.\n",
    );
  });

  it("should say everything looks good when nothing is wrong", () => {
    expect(formatDoctorReport([{ id: "node", status: "ok", message: "Node.js 24" }], false)).toBe(
      "  ✓ Node.js 24\n\n  Everything looks good.\n",
    );
  });
});
