import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeState, readState, removeState } from "../../src/orchestrator/state";
import type { WorkspaceState } from "../../src/orchestrator/types";

const sampleState: WorkspaceState = {
  workspaceName: "my-platform",
  projectName: "lo1-my-platform",
  fileArgs: [".lo1/docker-compose.yml"],
  workspaceDir: "/workspace",
  services: { "users-api": { runner: "process", pid: 50392 } },
};

describe("state", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lo1-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("writeState", () => {
    it("should create .lo1/state.json with serialized state", async () => {
      await writeState(sampleState, dir);

      const raw = await readFile(join(dir, ".lo1", "state.json"), "utf-8");
      const parsed = JSON.parse(raw) as WorkspaceState;

      expect(parsed.workspaceName).toBe("my-platform");
      expect(parsed.projectName).toBe("lo1-my-platform");
      expect(parsed.services).toEqual({ "users-api": { runner: "process", pid: 50392 } });
    });

    it("should create .lo1 directory if it does not exist", async () => {
      await writeState(sampleState, dir);

      const raw = await readFile(join(dir, ".lo1", "state.json"), "utf-8");
      expect(raw).toBeTruthy();
    });
  });

  describe("readState", () => {
    it("should return parsed state when file exists", async () => {
      await writeState(sampleState, dir);

      const result = await readState(dir);

      expect(result).not.toBeNull();
      expect(result!.workspaceName).toBe("my-platform");
      expect(result!.fileArgs).toEqual([".lo1/docker-compose.yml"]);
      expect(result!.services).toEqual({ "users-api": { runner: "process", pid: 50392 } });
    });

    it("should return null when file does not exist", async () => {
      const result = await readState(dir);

      expect(result).toBeNull();
    });
  });

  describe("removeState", () => {
    it("should delete the state file", async () => {
      await writeState(sampleState, dir);
      await removeState(dir);

      const result = await readState(dir);
      expect(result).toBeNull();
    });

    it("should not throw when file does not exist", async () => {
      await expect(removeState(dir)).resolves.toBeUndefined();
    });
  });
});
