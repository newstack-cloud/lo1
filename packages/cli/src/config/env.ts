import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { createLog } from "../debug";

const debug = createLog("config:env");

/**
 * Loads `<workspaceDir>/.env` into `env` without overriding variables that are
 * already set, so a value exported in the shell always wins. Services, hooks,
 * ACME credentials and Docker Compose interpolation all see the result.
 * Returns the names of the variables it set.
 */
export async function loadWorkspaceEnv(
  workspaceDir = ".",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(join(workspaceDir, ".env"), "utf-8");
  } catch {
    return [];
  }

  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }

  debug("loadWorkspaceEnv: loaded %d variable(s)", loaded.length);
  return loaded;
}
