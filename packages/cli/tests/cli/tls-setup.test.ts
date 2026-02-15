import { describe, it, expect, mock } from "bun:test";
import { runTlsSetup, type TlsSetupDeps } from "../../src/cli/commands/tls-setup";
import { TlsError } from "../../src/tls/setup";
import type { WorkspaceState } from "../../src/orchestrator/types";

const sampleState: WorkspaceState = {
  workspaceName: "my-platform",
  projectName: "lo1-my-platform",
  fileArgs: [".lo1/docker-compose.yml"],
  workspaceDir: "/workspace",
  services: {},
};

function makeDeps(overrides: Partial<TlsSetupDeps> = {}): TlsSetupDeps {
  return {
    readState: mock(() => Promise.resolve(sampleState)),
    trustCaddyCa: mock(() => Promise.resolve()),
    removeHashFile: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe("runTlsSetup", () => {
  it("should throw TlsError when no state file exists", async () => {
    const deps = makeDeps({
      readState: mock(() => Promise.resolve(null)),
    });

    expect(runTlsSetup("/workspace", deps)).rejects.toThrow(TlsError);
    expect(runTlsSetup("/workspace", deps)).rejects.toThrow(/No running workspace/);
  });

  it("should derive container name from project name in state", async () => {
    const deps = makeDeps();

    await runTlsSetup("/workspace", deps);

    expect(deps.trustCaddyCa).toHaveBeenCalledWith("lo1-my-platform-proxy", "/workspace");
  });

  it("should remove cached hash file before trusting", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      removeHashFile: mock(() => {
        callOrder.push("remove");
        return Promise.resolve();
      }),
      trustCaddyCa: mock(() => {
        callOrder.push("trust");
        return Promise.resolve();
      }),
    });

    await runTlsSetup("/workspace", deps);

    expect(callOrder).toEqual(["remove", "trust"]);
    expect(deps.removeHashFile).toHaveBeenCalledWith(
      "/workspace/.lo1/caddy-root.crt.sha256",
    );
  });

  it("should propagate TlsError from trustCaddyCa", async () => {
    const deps = makeDeps({
      trustCaddyCa: mock(() => Promise.reject(new TlsError("container not running"))),
    });

    expect(runTlsSetup("/workspace", deps)).rejects.toThrow(TlsError);
    expect(runTlsSetup("/workspace", deps)).rejects.toThrow(/container not running/);
  });

  it("should read state from the provided workspace dir", async () => {
    const deps = makeDeps();

    await runTlsSetup("/custom/path", deps);

    expect(deps.readState).toHaveBeenCalledWith("/custom/path");
  });
});
