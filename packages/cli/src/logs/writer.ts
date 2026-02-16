import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const LOGS_DIR = "logs";

export function logDir(workspaceDir = "."): string {
  return join(workspaceDir, ".lo1", LOGS_DIR);
}

export async function initLogDir(workspaceDir = "."): Promise<void> {
  const dir = logDir(workspaceDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

export async function appendLog(
  workspaceDir: string,
  category: string,
  text: string,
): Promise<void> {
  const ts = new Date().toISOString();
  const file = join(logDir(workspaceDir), `${category}.log`);
  await appendFile(file, `[${ts}] ${text}\n`, "utf-8");
}
