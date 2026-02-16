import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { platform } from "node:os";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("runner:process");

export class ProcessRunnerError extends Lo1Error {
  constructor(message: string) {
    super(message, "ProcessRunnerError");
    this.name = "ProcessRunnerError";
  }
}

export type OutputLine = {
  service: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: Date;
};

export type ProcessRunnerOptions = {
  serviceName: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  onOutput?: (line: OutputLine) => void;
};

export type ProcessHandle = {
  serviceName: string;
  readonly pid: number | undefined;
  readonly running: boolean;
  stop(timeoutMs?: number): Promise<number | null>;
  readonly exitPromise: Promise<number | null>;
};

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: StdioOptions },
) => ChildProcess;

function defaultSpawn(
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: StdioOptions },
): ChildProcess {
  return spawn(cmd, args, options);
}

function getShellArgs(command: string): { cmd: string; args: string[] } {
  if (platform() === "win32") {
    return { cmd: "cmd.exe", args: ["/c", command] };
  }
  return { cmd: "sh", args: ["-c", command] };
}

const DEFAULT_STOP_TIMEOUT = 5000;

export function startProcess(
  options: ProcessRunnerOptions,
  spawnFn: SpawnFn = defaultSpawn,
): ProcessHandle {
  debug("startProcess: command=%s cwd=%s", options.command, options.cwd);
  const { cmd, args } = getShellArgs(options.command);
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  Object.assign(mergedEnv, options.env);

  const child = spawnFn(cmd, args, {
    cwd: options.cwd,
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  debug("startProcess: pid=%d", child.pid);

  let isRunning = true;

  const makeOutputLine = (stream: "stdout" | "stderr", text: string): OutputLine => ({
    service: options.serviceName,
    stream,
    text,
    timestamp: new Date(),
  });

  if (options.onOutput && child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      options.onOutput!(makeOutputLine("stdout", chunk.toString()));
    });
  }

  if (options.onOutput && child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      options.onOutput!(makeOutputLine("stderr", chunk.toString()));
    });
  }

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("error", () => {
      isRunning = false;
      resolve(null);
    });
    child.on("close", (code) => {
      debug("process closed: pid=%d exit=%d", child.pid, code);
      isRunning = false;
      resolve(code);
    });
  });

  const stop = async (timeoutMs = DEFAULT_STOP_TIMEOUT): Promise<number | null> => {
    if (!isRunning) return exitPromise;

    if (platform() === "win32") {
      child.kill("SIGKILL");
    } else {
      child.kill("SIGTERM");

      const timer = setTimeout(() => {
        if (isRunning) child.kill("SIGKILL");
      }, timeoutMs);

      return exitPromise.then((code) => {
        clearTimeout(timer);
        return code;
      });
    }

    return exitPromise;
  };

  return {
    serviceName: options.serviceName,
    get pid() {
      return child.pid;
    },
    get running() {
      return isRunning;
    },
    stop,
    exitPromise,
  };
}
