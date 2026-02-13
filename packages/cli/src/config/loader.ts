import { readFile } from "node:fs/promises";
import { load as parseYaml } from "js-yaml";
import { workspaceSchema, type WorkspaceConfig } from "@lo1/sdk";

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
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
    const details = formatZodIssues(result.error.issues);
    throw new ConfigError(`Invalid config in ${configPath}:\n${details}`, result.error);
  }

  return result.data;
}
