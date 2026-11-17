import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordReplacement } from "../../src/cli/commands/up";
import { readState, writeState } from "../../src/orchestrator/state";

describe("recordReplacement", () => {
  it("points the state file at the restarted process and keeps the other services", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lo1-up-"));
    await writeState(
      {
        workspaceName: "shop",
        projectName: "lo1-shop",
        fileArgs: [],
        workspaceDir: dir,
        services: {
          api: { runner: "process", pid: 100 },
          web: { runner: "process", pid: 200 },
        },
      },
      dir,
    );

    await recordReplacement(dir, {
      serviceName: "api",
      type: "process",
      pid: 300,
      running: true,
      stop: async () => {},
    });

    const state = await readState(dir);
    expect(state?.services).toEqual({
      api: { runner: "process", pid: 300 },
      web: { runner: "process", pid: 200 },
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("does nothing once the workspace is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lo1-up-"));

    await recordReplacement(dir, { serviceName: "api", type: "process", pid: 1, running: true, stop: async () => {} });

    expect(await readState(dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
