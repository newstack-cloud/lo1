import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("orchestrator:lock");

export class WorkspaceLockError extends Lo1Error {
  constructor(message: string) {
    super(message, "WorkspaceLocked");
    this.name = "WorkspaceLockError";
  }
}

export type WorkspaceLockOptions = {
  /** How long to wait for another lo1 command to finish. */
  timeoutMs?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  /** Stops waiting for the lock, e.g. on Ctrl+C. */
  signal?: AbortSignal;
};

export function lockPath(workspaceDir: string): string {
  return join(workspaceDir, ".lo1", "state.lock");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

/**
 * Creates the lock with our pid already in it: the pid goes into a private
 * file that is then hard-linked into place, which fails if the lock exists.
 * Nobody can see a lock file without a pid and mistake it for a stale one.
 */
async function tryAcquire(path: string): Promise<boolean> {
  // Unique per attempt: the watcher may contend for the lock within one process.
  const own = `${path}.${process.pid}.${randomUUID()}`;
  await writeFile(own, String(process.pid));
  try {
    await link(own, path);
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(own).catch(() => {});
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** The lock file's contents, or null when there is no lock. Other read errors propagate. */
async function readLock(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
}

/**
 * Removes the lock only if it is still the stale one we checked. The lock is
 * first renamed to a private name, which is atomic, so nobody can replace it
 * between our check and the removal. If what we moved turns out to be a
 * newer lock, it is put back.
 */
export async function removeStaleLock(path: string, staleContent: string): Promise<void> {
  const moved = `${path}.stale.${randomUUID()}`;
  try {
    await rename(path, moved);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }

  if ((await readFile(moved, "utf-8")) !== staleContent) {
    debug("lock changed hands while removing a stale one; restoring it");
    await link(moved, path).catch(() => {});
  }
  await unlink(moved).catch(() => {});
}

/** The pid holding the lock, or null when the lock is gone or its holder has exited. */
async function liveHolder(path: string, isAlive: (pid: number) => boolean): Promise<number | null> {
  const content = await readLock(path);
  if (content === null) return null;

  const pid = Number.parseInt(content, 10);
  if (Number.isInteger(pid) && isAlive(pid)) return pid;

  await removeStaleLock(path, content);
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Runs `fn` while holding the workspace's state lock, so lo1 commands that
 * read, change and write the state file (restarts) never interleave. Waits
 * for a running holder and takes over a lock whose holder has exited.
 */
export async function withWorkspaceLock<T>(
  workspaceDir: string,
  fn: () => Promise<T>,
  options: WorkspaceLockOptions = {},
): Promise<T> {
  const { timeoutMs = 120_000, pollMs = 100, isAlive = isProcessAlive, signal } = options;
  const path = lockPath(workspaceDir);
  await mkdir(join(workspaceDir, ".lo1"), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (!(await tryAcquire(path))) {
    if (signal?.aborted) throw new WorkspaceLockError("Stopped waiting for the workspace lock.");
    const holder = await liveHolder(path, isAlive);
    if (holder === null) continue;
    if (Date.now() >= deadline) {
      throw new WorkspaceLockError(
        `Another lo1 command (pid ${holder}) is still changing this workspace. ` +
          `Wait for it to finish, then try again.`,
      );
    }
    await sleep(pollMs, signal);
  }

  debug("acquired %s", path);
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
    debug("released %s", path);
  }
}
