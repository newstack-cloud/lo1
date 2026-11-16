import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkspaceEnv } from "../../src/config/env";

describe("loadWorkspaceEnv", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lo1-env-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("should load variables from the workspace .env file", async () => {
    await writeFile(join(dir, ".env"), 'CF_API_TOKEN=abc\n# comment\nQUOTED="a b"\n');
    const env: NodeJS.ProcessEnv = {};

    const loaded = await loadWorkspaceEnv(dir, env);

    expect(env.CF_API_TOKEN).toBe("abc");
    expect(env.QUOTED).toBe("a b");
    expect(loaded).toEqual(["CF_API_TOKEN", "QUOTED"]);
  });

  it("should not override variables already set in the environment", async () => {
    await writeFile(join(dir, ".env"), "CF_API_TOKEN=from-file\n");
    const env: NodeJS.ProcessEnv = { CF_API_TOKEN: "from-shell" };

    const loaded = await loadWorkspaceEnv(dir, env);

    expect(env.CF_API_TOKEN).toBe("from-shell");
    expect(loaded).toEqual([]);
  });

  it("should do nothing when there is no .env file", async () => {
    const env: NodeJS.ProcessEnv = {};

    expect(await loadWorkspaceEnv(dir, env)).toEqual([]);
    expect(env).toEqual({});
  });
});
