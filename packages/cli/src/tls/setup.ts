import { execFile } from "node:child_process";
import { promisify } from "node:util";

const defaultExec = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class TlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsError";
  }
}

/**
 * Installs Caddy's root CA into the system trust store via `docker exec`.
 * Caddy uses `tls internal` to auto-generate certs — this step just
 * ensures browsers trust them without warnings.
 */
export async function trustCaddyCa(
  containerName = "lo1-proxy",
  exec: ExecFn = defaultExec,
): Promise<void> {
  try {
    await exec("docker", ["exec", containerName, "caddy", "trust"]);
  } catch (err) {
    throw new TlsError(
      `Failed to trust Caddy CA. Is the proxy container running?\n` +
        `Run "lo1 up" first, then retry "lo1 tls-setup".\n` +
        `Detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
