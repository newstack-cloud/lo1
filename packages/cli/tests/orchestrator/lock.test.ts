import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lockPath, removeStaleLock, withWorkspaceLock } from "../../src/orchestrator/lock";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "lo1-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("withWorkspaceLock", () => {
  it("runs one holder at a time", () =>
    withTempDir(async (dir) => {
      const order: string[] = [];
      const hold = (name: string) =>
        withWorkspaceLock(
          dir,
          async () => {
            order.push(`${name} in`);
            await new Promise((r) => setTimeout(r, 30));
            order.push(`${name} out`);
          },
          { pollMs: 5 },
        );

      await Promise.all([hold("a"), hold("b"), hold("c")]);

      // Whatever the order, each holder leaves before the next one enters.
      expect(order).toHaveLength(6);
      for (let i = 0; i < order.length; i += 2) {
        expect(order[i].replace(" in", "")).toBe(order[i + 1].replace(" out", ""));
      }
    }));

  it("records its pid while held and removes the lock afterwards, even on failure", () =>
    withTempDir(async (dir) => {
      let held = "";
      await withWorkspaceLock(dir, async () => {
        held = await readFile(lockPath(dir), "utf-8");
      });
      const failed = withWorkspaceLock(dir, () => Promise.reject(new Error("boom")));

      expect(held).toBe(String(process.pid));
      await expect(failed).rejects.toThrow("boom");
      await expect(readFile(lockPath(dir), "utf-8")).rejects.toThrow();
    }));

  it("takes over a lock whose holder has exited", () =>
    withTempDir(async (dir) => {
      await mkdir(join(dir, ".lo1"), { recursive: true });
      await writeFile(lockPath(dir), "999999");

      const result = await withWorkspaceLock(dir, async () => "ran", { isAlive: () => false });

      expect(result).toBe("ran");
    }));

  it("gives up with a clear error while another command keeps the lock", () =>
    withTempDir(async (dir) => {
      await mkdir(join(dir, ".lo1"), { recursive: true });
      await writeFile(lockPath(dir), "4242");

      const attempt = withWorkspaceLock(dir, async () => "ran", {
        isAlive: () => true,
        timeoutMs: 30,
        pollMs: 5,
      });

      await expect(attempt).rejects.toThrow("Another lo1 command (pid 4242)");
    }));

  it("stops waiting when its signal aborts", () =>
    withTempDir(async (dir) => {
      await mkdir(join(dir, ".lo1"), { recursive: true });
      await writeFile(lockPath(dir), "4242");
      const controller = new AbortController();

      const attempt = withWorkspaceLock(dir, async () => "ran", {
        isAlive: () => true,
        pollMs: 5,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);

      await expect(attempt).rejects.toThrow("Stopped waiting for the workspace lock.");
    }));

  it("removes a stale lock, but not a lock that has replaced it since it was checked", () =>
    withTempDir(async (dir) => {
      await mkdir(join(dir, ".lo1"), { recursive: true });
      // Holder 111 was found stale, but 222 took the lock before the removal.
      await writeFile(lockPath(dir), "222");

      await removeStaleLock(lockPath(dir), "111");
      const kept = await readFile(lockPath(dir), "utf-8");
      await removeStaleLock(lockPath(dir), "222");

      expect(kept).toBe("222");
      await expect(readFile(lockPath(dir), "utf-8")).rejects.toThrow();
      expect((await readdir(join(dir, ".lo1"))).length).toBe(0);
    }));

  it("propagates errors reading the lock other than it being missing", () =>
    withTempDir(async (dir) => {
      // A directory where the lock file should be makes linking fail with EEXIST
      // and reading it fail with EISDIR.
      await mkdir(lockPath(dir), { recursive: true });

      await expect(withWorkspaceLock(dir, async () => "ran", { timeoutMs: 50 })).rejects.toThrow(
        /EISDIR/,
      );
    }));
});
