import { execFile, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { createLineBuffer } from "../output/line-buffer";

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
  options?: { cwd?: string; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export type ComposeOutputLine = {
  stream: "stdout" | "stderr";
  text: string;
};

export type ComposeExecOptions = {
  projectName: string;
  fileArgs: string[];
  services?: string[];
  cwd?: string;
  signal?: AbortSignal;
  onOutput?: (line: ComposeOutputLine) => void;
};

export type ComposeServiceStatus = {
  Name: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
};

export type ComposeLogLine = {
  service: string;
  stream: "stdout" | "stderr";
  text: string;
};

export type ComposeLogsHandle = {
  kill: () => void;
};

/** Minimal subset of ChildProcess used by compose runners. */
export type SpawnedChild = EventEmitter & {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  kill(signal?: NodeJS.Signals | number): unknown;
};

export type ComposeSpawnFn = (
  cmd: string,
  args: string[],
  options: { cwd?: string; stdio: ["ignore", "pipe", "pipe"] },
) => SpawnedChild;

function buildBaseArgs(options: ComposeExecOptions): string[] {
  const args = [
    "compose",
    "--progress",
    "plain",
    "--project-directory",
    ".",
    "-p",
    options.projectName,
  ];
  for (const file of options.fileArgs) {
    args.push("-f", file);
  }
  return args;
}

export async function composeUp(
  options: ComposeExecOptions,
  spawnFn: ComposeSpawnFn = spawn,
): Promise<void> {
  const args = [...buildBaseArgs(options), "up", "-d", "--build"];
  if (options.services?.length) {
    args.push(...options.services);
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawnFn("docker", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (options.onOutput) {
      const emit = options.onOutput;
      child.stdout?.on("data", (chunk: Buffer) => {
        emit({ stream: "stdout", text: chunk.toString() });
      });
    }

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill("SIGTERM");
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      options.onOutput?.({ stream: "stderr", text });
    });

    child.on("close", (code: number | null) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(new ComposeExecError("docker compose up aborted"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new ComposeExecError(
            `docker compose up failed with exit code ${code}`,
            stderrBuf || undefined,
          ),
        );
      }
    });

    child.on("error", (err: Error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ComposeExecError(`docker compose up failed: ${err.message}`));
    });
  });
}

export function composeLogs(
  options: ComposeExecOptions,
  onLog: (line: ComposeLogLine) => void,
  spawnFn: ComposeSpawnFn = spawn,
): ComposeLogsHandle {
  const args = [...buildBaseArgs(options), "logs", "-f", "--no-color", "--since", "0s"];
  const child = spawnFn("docker", args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const parseLine = (raw: string, stream: "stdout" | "stderr") => {
    // Docker Compose log format: "service-name-N  | log content"
    const match = raw.match(/^(\S+)\s+\|\s?(.*)/);
    if (match) {
      const service = match[1].replace(/-\d+$/, "");
      onLog({ service, stream, text: match[2] });
    }
  };

  const stdoutBuffer = createLineBuffer((line) => parseLine(line, "stdout"));
  child.stdout?.on("data", (chunk: Buffer) => stdoutBuffer(chunk.toString()));

  const stderrBuffer = createLineBuffer((line) => parseLine(line, "stderr"));
  child.stderr?.on("data", (chunk: Buffer) => stderrBuffer(chunk.toString()));

  if (options.signal) {
    const onAbort = () => child.kill("SIGTERM");
    if (options.signal.aborted) {
      child.kill("SIGTERM");
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return { kill: () => child.kill("SIGTERM") };
}

export type ComposeWaitOptions = {
  projectName: string;
  fileArgs: string[];
  services: string[];
  cwd?: string;
  signal?: AbortSignal;
  pollInterval?: number;
  timeout?: number;
  /** Services that must exit (code 0) before being considered ready.
   *  Typically init-task containers like migrators or seed scripts. */
  waitForExit?: string[];
};

/**
 * Polls `docker compose ps` until all target services reach a terminal state:
 * - Long-running services: "running" with health "healthy" or no healthcheck
 * - Init-task services (in `waitForExit`): must reach "exited" with code 0
 * Throws on unhealthy services, non-zero exit codes, or timeout.
 */
export async function composeWait(
  options: ComposeWaitOptions,
  exec: ExecFn = defaultExec,
): Promise<void> {
  const pollInterval = options.pollInterval ?? 2000;
  const timeout = options.timeout ?? 300_000;
  const startTime = Date.now();
  const targetServices = new Set(options.services);
  const mustExit = new Set(options.waitForExit ?? []);

  if (targetServices.size === 0) return;

  while (true) {
    if (options.signal?.aborted) {
      throw new ComposeExecError("compose wait aborted");
    }

    const statuses = await composePs(
      { projectName: options.projectName, fileArgs: options.fileArgs, cwd: options.cwd },
      exec,
    );

    const statusByService = new Map<string, ComposeServiceStatus>();
    for (const s of statuses) {
      statusByService.set(s.Service, s);
    }

    let allReady = true;
    const pending: string[] = [];

    for (const service of targetServices) {
      const status = statusByService.get(service);
      if (!status) {
        allReady = false;
        pending.push(`${service} (not found)`);
        continue;
      }

      if (status.State === "running") {
        if (status.Health === "unhealthy") {
          throw new ComposeExecError(`Service "${service}" is unhealthy`);
        }
        if (status.Health === "starting") {
          allReady = false;
          pending.push(`${service} (health: starting)`);
        } else if (mustExit.has(service)) {
          // Init-task service is still running — keep polling until it exits
          allReady = false;
          pending.push(`${service} (waiting to exit)`);
        }
        // Non-mustExit: Health "" or "healthy" → ready
      } else if (status.State === "exited") {
        if (status.ExitCode !== 0) {
          throw new ComposeExecError(`Service "${service}" exited with code ${status.ExitCode}`);
        }
        // exit code 0 → completed successfully
      } else {
        // "created", "restarting", "paused", "removing", "dead" → keep waiting
        allReady = false;
        pending.push(`${service} (${status.State})`);
      }
    }

    if (allReady) return;

    if (Date.now() - startTime > timeout) {
      throw new ComposeExecError(`Timed out waiting for services: ${pending.join(", ")}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

export async function composeDown(
  options: ComposeExecOptions & { clean?: boolean },
  exec: ExecFn = defaultExec,
): Promise<void> {
  const args = [...buildBaseArgs(options), "down"];
  if (options.clean) {
    args.push("-v", "--remove-orphans");
  }

  try {
    await exec("docker", args, { cwd: options.cwd, signal: options.signal });
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
  const args = [...buildBaseArgs(options), "ps", "-a", "--format", "json"];

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
