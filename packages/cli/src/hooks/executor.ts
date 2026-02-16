import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("hooks");

export class HookError extends Lo1Error {
  constructor(
    message: string,
    public readonly hookName: string,
    public readonly exitCode: number | null,
  ) {
    super(message, "HookError", { hook: hookName, exitCode });
    this.name = "HookError";
  }
}

export type HookOutput = { stream: "stdout" | "stderr"; text: string };
export type HookResult = { exitCode: number; hookName: string };

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
) => ChildProcess;

function defaultSpawn(
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
): ChildProcess {
  return spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getShellArgs(command: string): { cmd: string; args: string[] } {
  if (platform() === "win32") {
    return { cmd: "cmd.exe", args: ["/c", command] };
  }
  return { cmd: "sh", args: ["-c", command] };
}

export async function executeHook(
  hookName: string,
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    signal?: AbortSignal;
    onOutput?: (output: HookOutput) => void;
  },
  spawnFn: SpawnFn = defaultSpawn,
): Promise<HookResult> {
  debug("executeHook: name=%s command=%s cwd=%s", hookName, command, options.cwd);
  const { cmd, args } = getShellArgs(command);
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  Object.assign(mergedEnv, options.env);

  const child = spawnFn(cmd, args, {
    cwd: options.cwd,
    env: mergedEnv,
    signal: options.signal,
  });

  if (options.onOutput && child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      options.onOutput!({ stream: "stdout", text: chunk.toString() });
    });
  }

  if (options.onOutput && child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      options.onOutput!({ stream: "stderr", text: chunk.toString() });
    });
  }

  return new Promise<HookResult>((resolve, reject) => {
    child.on("error", (err) => {
      reject(new HookError(`Hook "${hookName}" failed to start: ${err.message}`, hookName, null));
    });

    child.on("close", (code) => {
      debug("executeHook: name=%s exit=%d", hookName, code);
      if (code === 0) {
        resolve({ exitCode: 0, hookName });
      } else {
        reject(new HookError(`Hook "${hookName}" exited with code ${code}`, hookName, code));
      }
    });
  });
}
