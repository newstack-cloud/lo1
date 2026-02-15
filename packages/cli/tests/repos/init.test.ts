import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { initRepositories, type ExecFn } from "../../src/repos/init";
import type { WorkspaceConfig } from "@lo1/sdk";

const TEST_DIR = join(import.meta.dir, ".tmp-repos-test");

function makeConfig(
  repositories: Record<string, { url: string; path: string; branch?: string }>,
): WorkspaceConfig {
  return {
    version: "1",
    name: "test",
    repositories,
    services: { stub: { type: "service", path: "./stub" } },
  } as unknown as WorkspaceConfig;
}

let execMock: ReturnType<typeof mock<ExecFn>>;

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  execMock = mock<ExecFn>(() => Promise.resolve({ stdout: "", stderr: "" }));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("initRepositories", () => {
  it("should return empty results when no repositories defined", async () => {
    const config = {
      version: "1",
      name: "test",
      services: { stub: { type: "service", path: "./stub" } },
    } as unknown as WorkspaceConfig;

    const result = await initRepositories(config, { cwd: TEST_DIR }, execMock);

    expect(result.results).toEqual([]);
    expect(result.clonedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it("should clone a new repository", async () => {
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
    });

    const result = await initRepositories(config, { cwd: TEST_DIR }, execMock);

    expect(result.clonedCount).toBe(1);
    expect(result.results[0].cloned).toBe(true);
    expect(result.results[0].name).toBe("api");
    expect(execMock).toHaveBeenCalledWith(
      "git",
      ["clone", "git@github.com:org/api.git", join(TEST_DIR, "api")],
    );
  });

  it("should skip existing directories", async () => {
    const existingPath = join(TEST_DIR, "api");
    await mkdir(existingPath, { recursive: true });
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
    });

    const result = await initRepositories(config, { cwd: TEST_DIR }, execMock);

    expect(result.skippedCount).toBe(1);
    expect(result.clonedCount).toBe(0);
    expect(result.results[0].cloned).toBe(false);
    expect(result.results[0].error).toBeUndefined();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("should checkout branch after cloning", async () => {
    const config = makeConfig({
      api: {
        url: "git@github.com:org/api.git",
        path: "./api",
        branch: "develop",
      },
    });

    await initRepositories(config, { cwd: TEST_DIR }, execMock);

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenCalledWith(
      "git",
      ["checkout", "develop"],
      { cwd: join(TEST_DIR, "api") },
    );
  });

  it("should handle multiple repositories", async () => {
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
      web: { url: "git@github.com:org/web.git", path: "./web" },
    });

    const result = await initRepositories(config, { cwd: TEST_DIR }, execMock);

    expect(result.clonedCount).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it("should continue on failure by default", async () => {
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
      web: { url: "git@github.com:org/web.git", path: "./web" },
    });
    execMock.mockImplementationOnce(() => Promise.reject(new Error("clone failed")));

    const result = await initRepositories(config, { cwd: TEST_DIR }, execMock);

    expect(result.failedCount).toBe(1);
    expect(result.clonedCount).toBe(1);
    expect(result.results).toHaveLength(2);
  });

  it("should stop on first failure when failFast is true", async () => {
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
      web: { url: "git@github.com:org/web.git", path: "./web" },
    });
    execMock.mockImplementationOnce(() => Promise.reject(new Error("clone failed")));

    const result = await initRepositories(
      config,
      { cwd: TEST_DIR, failFast: true },
      execMock,
    );

    expect(result.failedCount).toBe(1);
    expect(result.results).toHaveLength(1);
  });
});
