import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
};

export function lockPath(workspaceDir: string): string {
  return join(workspaceDir, ".lo1", "state.lock");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(own).catch(() => {});
  }
}

/** The pid holding the lock, or null when the lock is gone or its holder has exited. */
async function liveHolder(path: string, isAlive: (pid: number) => boolean): Promise<number | null> {
  const content = await readFile(path, "utf-8").catch(() => "");
  const pid = Number.parseInt(content, 10);
  if (Number.isInteger(pid) && isAlive(pid)) return pid;

  await unlink(path).catch(() => {});
  return null;
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
  const { timeoutMs = 120_000, pollMs = 100, isAlive = isProcessAlive } = options;
  const path = lockPath(workspaceDir);
  await mkdir(join(workspaceDir, ".lo1"), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (!(await tryAcquire(path))) {
    const holder = await liveHolder(path, isAlive);
    if (holder === null) continue;
    if (Date.now() >= deadline) {
      throw new WorkspaceLockError(
        `Another lo1 command (pid ${holder}) is still changing this workspace. ` +
          `Wait for it to finish, then try again.`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  debug("acquired %s", path);
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
    debug("released %s", path);
  }
}
