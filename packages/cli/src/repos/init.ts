import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceConfig } from "@lo1/sdk";

const execFileAsync = promisify(execFile);

export type CloneResult = {
  name: string;
  path: string;
  cloned: boolean;
  error?: Error;
};

export type InitReposResult = {
  results: CloneResult[];
  clonedCount: number;
  skippedCount: number;
  failedCount: number;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initRepositories(
  config: WorkspaceConfig,
  options?: { cwd?: string; failFast?: boolean },
): Promise<InitReposResult> {
  const cwd = options?.cwd ?? process.cwd();
  const failFast = options?.failFast ?? false;
  const repositories = config.repositories ?? {};
  const results: CloneResult[] = [];

  for (const [name, repo] of Object.entries(repositories)) {
    const targetPath = resolve(cwd, repo.path);

    if (await pathExists(targetPath)) {
      results.push({ name, path: targetPath, cloned: false });
      continue;
    }

    try {
      await execFileAsync("git", ["clone", repo.url, targetPath]);

      if (repo.branch) {
        await execFileAsync("git", ["checkout", repo.branch], {
          cwd: targetPath,
        });
      }

      results.push({ name, path: targetPath, cloned: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      results.push({ name, path: targetPath, cloned: false, error });

      if (failFast) {
        break;
      }
    }
  }

  return {
    results,
    clonedCount: results.filter((r) => r.cloned).length,
    skippedCount: results.filter((r) => !r.cloned && !r.error).length,
    failedCount: results.filter((r) => r.error).length,
  };
}
