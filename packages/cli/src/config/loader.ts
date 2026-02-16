import { readFile } from "node:fs/promises";
import { load as parseYaml } from "js-yaml";
import { workspaceSchema, type WorkspaceConfig } from "@lo1/sdk";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("config");

export class ConfigError extends Lo1Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message, "ConfigError");
    this.name = "ConfigError";
  }
}

function formatZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

export async function loadWorkspaceConfig(configPath = "lo1.yaml"): Promise<WorkspaceConfig> {
  debug("loading config from %s", configPath);

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    throw new ConfigError(`Could not read config file: ${configPath}`, err);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${configPath}`, err);
  }

  const result = workspaceSchema.safeParse(parsed);
  if (!result.success) {
    debug("validation failed: %d issues", result.error.issues.length);
    const details = formatZodIssues(result.error.issues);
    throw new ConfigError(`Invalid config in ${configPath}:\n${details}`, result.error);
  }

  debug(
    "loaded workspace %s with %d services",
    result.data.name,
    Object.keys(result.data.services).length,
  );
  return result.data;
}
