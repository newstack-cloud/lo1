import { execFile } from "node:child_process";
import { promisify } from "node:util";

const defaultExec = promisify(execFile);

export class ComposeExecError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "ComposeExecError";
  }
}

export type ExecFn = (
  cmd: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export type ComposeExecOptions = {
  projectName: string;
  fileArgs: string[];
  cwd?: string;
};

export type ComposeServiceStatus = {
  Name: string;
  Service: string;
  State: string;
  Health: string;
};

function buildBaseArgs(options: ComposeExecOptions): string[] {
  const args = ["compose", "-p", options.projectName];
  for (const file of options.fileArgs) {
    args.push("-f", file);
  }
  return args;
}

export async function composeUp(
  options: ComposeExecOptions,
  exec: ExecFn = defaultExec,
): Promise<void> {
  const args = [...buildBaseArgs(options), "up", "-d", "--wait"];

  try {
    await exec("docker", args, { cwd: options.cwd });
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : undefined;
    throw new ComposeExecError(
      `docker compose up failed: ${err instanceof Error ? err.message : String(err)}`,
      stderr,
    );
  }
}

export async function composeDown(
  options: ComposeExecOptions,
  exec: ExecFn = defaultExec,
): Promise<void> {
  const args = [...buildBaseArgs(options), "down"];

  try {
    await exec("docker", args, { cwd: options.cwd });
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : undefined;
    throw new ComposeExecError(
      `docker compose down failed: ${err instanceof Error ? err.message : String(err)}`,
      stderr,
    );
  }
}

export async function composePs(
  options: ComposeExecOptions,
  exec: ExecFn = defaultExec,
): Promise<ComposeServiceStatus[]> {
  const args = [...buildBaseArgs(options), "ps", "--format", "json"];

  let result: { stdout: string };
  try {
    result = await exec("docker", args, { cwd: options.cwd });
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : undefined;
    throw new ComposeExecError(
      `docker compose ps failed: ${err instanceof Error ? err.message : String(err)}`,
      stderr,
    );
  }

  const stdout = result.stdout.trim();
  if (!stdout) return [];

  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ComposeServiceStatus);
}
