import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceConfig } from "@lo1/sdk";

// Mock child_process.execFile before importing the module
const execFileMock = mock(
  (_cmd: string, _args: string[], _opts?: { cwd?: string }) =>
    Promise.resolve({ stdout: "", stderr: "" }),
);

mock.module("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    optsOrCb?: { cwd?: string } | ((...args: unknown[]) => void),
    maybeCb?: (...args: unknown[]) => void,
  ) => {
    // promisify calls execFile(cmd, args, cb) or execFile(cmd, args, opts, cb)
    const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb!;
    const opts = typeof optsOrCb === "object" ? optsOrCb : undefined;
    execFileMock(cmd, args, opts)
      .then((result) => cb(null, result.stdout, result.stderr))
      .catch((err) => cb(err));
  },
  // Provide spawn stub so other modules importing from node:child_process don't break
  spawn: () => {},
}));

// Import after mock setup
const { initRepositories } = await import("../../src/repos/init");

const TEST_DIR = join(import.meta.dir, ".tmp-repos-test");

function makeConfig(
  repositories: Record<string, { url: string; path: string; branch?: string }>,
): WorkspaceConfig {
  return {
    version: "1",
    name: "test",
    repositories,
    services: { stub: { type: "process", path: "./stub" } },
  } as unknown as WorkspaceConfig;
}

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  execFileMock.mockClear();
  execFileMock.mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("initRepositories", () => {
  it("should return empty results when no repositories defined", async () => {
    // Arrange
    const config = {
      version: "1",
      name: "test",
      services: { stub: { type: "process", path: "./stub" } },
    } as unknown as WorkspaceConfig;

    // Act
    const result = await initRepositories(config, { cwd: TEST_DIR });

    // Assert
    expect(result.results).toEqual([]);
    expect(result.clonedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it("should clone a new repository", async () => {
    // Arrange
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
    });

    // Act
    const result = await initRepositories(config, { cwd: TEST_DIR });

    // Assert
    expect(result.clonedCount).toBe(1);
    expect(result.results[0].cloned).toBe(true);
    expect(result.results[0].name).toBe("api");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["clone", "git@github.com:org/api.git", join(TEST_DIR, "api")],
      undefined,
    );
  });

  it("should skip existing directories", async () => {
    // Arrange
    const existingPath = join(TEST_DIR, "api");
    await mkdir(existingPath, { recursive: true });
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
    });

    // Act
    const result = await initRepositories(config, { cwd: TEST_DIR });

    // Assert
    expect(result.skippedCount).toBe(1);
    expect(result.clonedCount).toBe(0);
    expect(result.results[0].cloned).toBe(false);
    expect(result.results[0].error).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("should checkout branch after cloning", async () => {
    // Arrange
    const config = makeConfig({
      api: {
        url: "git@github.com:org/api.git",
        path: "./api",
        branch: "develop",
      },
    });

    // Act
    await initRepositories(config, { cwd: TEST_DIR });

    // Assert
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["checkout", "develop"],
      { cwd: join(TEST_DIR, "api") },
    );
  });

  it("should handle multiple repositories", async () => {
    // Arrange
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
      web: { url: "git@github.com:org/web.git", path: "./web" },
    });

    // Act
    const result = await initRepositories(config, { cwd: TEST_DIR });

    // Assert
    expect(result.clonedCount).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it("should continue on failure by default", async () => {
    // Arrange
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
      web: { url: "git@github.com:org/web.git", path: "./web" },
    });
    execFileMock.mockImplementationOnce(() =>
      Promise.reject(new Error("clone failed")),
    );

    // Act
    const result = await initRepositories(config, { cwd: TEST_DIR });

    // Assert
    expect(result.failedCount).toBe(1);
    expect(result.clonedCount).toBe(1);
    expect(result.results).toHaveLength(2);
  });

  it("should stop on first failure when failFast is true", async () => {
    // Arrange
    const config = makeConfig({
      api: { url: "git@github.com:org/api.git", path: "./api" },
      web: { url: "git@github.com:org/web.git", path: "./web" },
    });
    execFileMock.mockImplementationOnce(() =>
      Promise.reject(new Error("clone failed")),
    );

    // Act
    const result = await initRepositories(config, {
      cwd: TEST_DIR,
      failFast: true,
    });

    // Assert
    expect(result.failedCount).toBe(1);
    expect(result.results).toHaveLength(1);
  });
});
