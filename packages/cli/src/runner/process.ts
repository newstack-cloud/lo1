import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { platform } from "node:os";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";
import { followLines } from "../output/line-buffer";

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
  /**
   * Run the process in its own process group with stdout and stderr appended
   * to this file, so it can keep running after lo1 exits (`lo1 up --detach`).
   * onOutput is not called in this mode.
   */
  logFile?: string;
};

export type ProcessHandle = {
  serviceName: string;
  readonly pid: number | undefined;
  readonly running: boolean;
  stop(timeoutMs?: number): Promise<number | null>;
  readonly exitPromise: Promise<number | null>;
  /** Lets lo1 exit while the process keeps running. Only meaningful with logFile. */
  detach(): void;
};

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  stdio: StdioOptions;
  detached?: boolean;
  windowsHide?: boolean;
};

export type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;

function defaultSpawn(cmd: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(cmd, args, options);
}

/**
 * Sends a signal to a process and, when it leads its own process group, to
 * everything it started. A dev command usually runs under `sh -c`, so
 * signalling only the shell would leave the real server running.
 */
export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (platform() !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a process group leader; fall back to the process itself.
    }
  }
  process.kill(pid, signal);
}

function spawnDetached(
  spawnFn: SpawnFn,
  cmd: string,
  args: string[],
  options: ProcessRunnerOptions & { logFile: string; env: Record<string, string> },
): ChildProcess {
  const fd = openSync(options.logFile, "a");
  try {
    return spawnFn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", fd, fd],
      detached: true,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
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

  const isDetached = options.logFile !== undefined;
  const child = options.logFile
    ? spawnDetached(spawnFn, cmd, args, { ...options, logFile: options.logFile, env: mergedEnv })
    : spawnFn(cmd, args, { cwd: options.cwd, env: mergedEnv, stdio: ["ignore", "pipe", "pipe"] });
  debug("startProcess: pid=%d detached=%s", child.pid, isDetached);

  const sendSignal = (signal: NodeJS.Signals) => {
    if (isDetached && child.pid !== undefined) {
      try {
        signalProcessTree(child.pid, signal);
      } catch {
        // Already exited
      }
      return;
    }
    child.kill(signal);
  };

  let isRunning = true;

  const makeOutputLine = (stream: "stdout" | "stderr", text: string): OutputLine => ({
    service: options.serviceName,
    stream,
    text,
    timestamp: new Date(),
  });

  const onOutput = options.onOutput;
  if (onOutput && child.stdout) {
    followLines(child.stdout, (line) => onOutput(makeOutputLine("stdout", line)));
  }
  if (onOutput && child.stderr) {
    followLines(child.stderr, (line) => onOutput(makeOutputLine("stderr", line)));
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
      sendSignal("SIGKILL");
    } else {
      sendSignal("SIGTERM");

      const timer = setTimeout(() => {
        if (isRunning) sendSignal("SIGKILL");
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
    detach: () => child.unref(),
  };
}
