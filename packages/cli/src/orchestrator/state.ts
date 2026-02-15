import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceState } from "./types";

const STATE_FILE = "state.json";

function statePath(workspaceDir = "."): string {
  return join(workspaceDir, ".lo1", STATE_FILE);
}

export async function writeState(state: WorkspaceState, workspaceDir = "."): Promise<void> {
  const dir = join(workspaceDir, ".lo1");
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(workspaceDir), JSON.stringify(state, null, 2), "utf-8");
}

export async function readState(workspaceDir = "."): Promise<WorkspaceState | null> {
  try {
    const raw = await readFile(statePath(workspaceDir), "utf-8");
    return JSON.parse(raw) as WorkspaceState;
  } catch {
    return null;
  }
}

export async function removeState(workspaceDir = "."): Promise<void> {
  try {
    await unlink(statePath(workspaceDir));
  } catch {
    // Ignore if file doesn't exist
  }
}
