import { execFile, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerConfig } from "@lo1/sdk";
import type { OutputLine } from "./process";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("runner:container");

const defaultExec = promisify(execFile);

export class ContainerRunnerError extends Lo1Error {
  constructor(message: string) {
    super(message, "ContainerRunnerError");
    this.name = "ContainerRunnerError";
  }
}

export type ContainerRunnerOptions = {
  workspaceName: string;
  serviceName: string;
  containerConfig: ContainerConfig;
  networkName: string;
  env: Record<string, string>;
  onOutput?: (line: OutputLine) => void;
};

export type ContainerHandle = {
  serviceName: string;
  containerId: string;
  readonly running: boolean;
  stop(timeoutMs?: number): Promise<void>;
  readonly exitPromise: Promise<number | null>;
};

export type ExecFn = (
  cmd: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export type LogSpawnFn = (
  cmd: string,
  args: string[],
  options?: { stdio?: StdioOptions },
) => ChildProcess;

function defaultLogSpawn(
  cmd: string,
  args: string[],
  options?: { stdio?: StdioOptions },
): ChildProcess {
  return spawn(cmd, args, options ?? {});
}

const DEFAULT_STOP_TIMEOUT = 10;

function containerName(options: ContainerRunnerOptions): string {
  return `lo1-${options.workspaceName}-${options.serviceName}`;
}

function buildRunArgs(options: ContainerRunnerOptions): string[] {
  const { containerConfig, networkName, env } = options;
  const args = ["run", "-d", "--name", containerName(options), "--network", networkName];

  for (const bind of containerConfig.binds) {
    args.push("-v", bind);
  }

  args.push("-w", containerConfig.workingDir);

  const mergedEnv = { ...containerConfig.envVars, ...env };
  for (const [key, value] of Object.entries(mergedEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(containerConfig.image, ...containerConfig.cmd);
  return args;
}

export async function startContainer(
  options: ContainerRunnerOptions,
  exec: ExecFn = defaultExec,
  logSpawn: LogSpawnFn = defaultLogSpawn,
): Promise<ContainerHandle> {
  const name = containerName(options);
  debug("startContainer: name=%s image=%s", name, options.containerConfig.image);
  const args = buildRunArgs(options);

  let result: { stdout: string };
  try {
    result = await exec("docker", args);
  } catch (err) {
    throw new ContainerRunnerError(
      `Failed to start container for "${options.serviceName}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const containerId = result.stdout.trim();
  debug("startContainer: id=%s", containerId);
  let isRunning = true;

  const logChild = logSpawn("docker", ["logs", "-f", containerId], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (options.onOutput && logChild.stdout) {
    logChild.stdout.on("data", (chunk: Buffer) => {
      options.onOutput!({
        service: options.serviceName,
        stream: "stdout",
        text: chunk.toString(),
        timestamp: new Date(),
      });
    });
  }

  if (options.onOutput && logChild.stderr) {
    logChild.stderr.on("data", (chunk: Buffer) => {
      options.onOutput!({
        service: options.serviceName,
        stream: "stderr",
        text: chunk.toString(),
        timestamp: new Date(),
      });
    });
  }

  const exitPromise = new Promise<number | null>((resolve) => {
    logChild.on("close", () => {
      isRunning = false;
      resolve(null);
    });
    logChild.on("error", () => {
      isRunning = false;
      resolve(null);
    });
  });

  const stop = async (timeoutMs?: number): Promise<void> => {
    const timeout = timeoutMs !== undefined ? Math.ceil(timeoutMs / 1000) : DEFAULT_STOP_TIMEOUT;
    const name = containerName(options);
    debug("stopContainer: name=%s", name);

    try {
      await exec("docker", ["stop", "-t", String(timeout), name]);
    } catch {
      // Container may have already stopped
    }

    try {
      await exec("docker", ["rm", name]);
    } catch {
      // Container may have already been removed
    }

    logChild.kill();
    isRunning = false;
  };

  return {
    serviceName: options.serviceName,
    containerId,
    get running() {
      return isRunning;
    },
    stop,
    exitPromise,
  };
}
