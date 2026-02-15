import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const defaultExec = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type TlsDeps = {
  exec: ExecFn;
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  hash: (content: string) => string;
  platform: string;
};

export class TlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsError";
  }
}

const CA_CERT_PATH = "/data/caddy/pki/authorities/local/root.crt";
const CERT_FILE = "caddy-root.crt";
const HASH_FILE = "caddy-root.crt.sha256";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createDefaultDeps(): TlsDeps {
  return {
    exec: defaultExec,
    readFile: async (path) => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return null;
      }
    },
    writeFile: async (path, content) => {
      await writeFile(path, content, "utf-8");
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    hash: sha256,
    platform: process.platform,
  };
}

/**
 * Extracts Caddy's root CA from the container, installs it in the host
 * trust store, and caches a hash so subsequent runs are skipped when
 * the cert hasn't changed.
 */
export async function trustCaddyCa(
  containerName = "lo1-proxy",
  workspaceDir = ".",
  overrides: Partial<TlsDeps> = {},
): Promise<void> {
  const deps = { ...createDefaultDeps(), ...overrides };
  const certDir = join(workspaceDir, ".lo1");
  const certPath = join(certDir, CERT_FILE);
  const hashPath = join(certDir, HASH_FILE);

  const cert = await extractCaCert(containerName, deps);
  const certHash = deps.hash(cert);

  const cachedHash = await deps.readFile(hashPath);
  if (cachedHash && cachedHash.trim() === certHash) return;

  await deps.mkdir(certDir);
  await deps.writeFile(certPath, cert);
  await installOnHost(certPath, deps);
  await deps.writeFile(hashPath, certHash);
}

async function extractCaCert(containerName: string, deps: TlsDeps): Promise<string> {
  try {
    const { stdout } = await deps.exec("docker", ["exec", containerName, "cat", CA_CERT_PATH]);
    return stdout;
  } catch (err) {
    throw new TlsError(
      `Failed to extract Caddy CA certificate. Is the proxy container running?\n` +
        `Detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function installOnHost(certPath: string, deps: TlsDeps): Promise<void> {
  try {
    if (deps.platform === "darwin") {
      await deps.exec("security", [
        "add-trusted-cert",
        "-r",
        "trustRoot",
        "-k",
        `${process.env.HOME}/Library/Keychains/login.keychain-db`,
        certPath,
      ]);
      return;
    }

    if (deps.platform === "win32") {
      await deps.exec("certutil", ["-addstore", "-user", "Root", certPath]);
      return;
    }

    await deps.exec("sudo", ["cp", certPath, "/usr/local/share/ca-certificates/caddy-root.crt"]);
    await deps.exec("sudo", ["update-ca-certificates"]);
  } catch (err) {
    throw new TlsError(
      `Failed to install Caddy CA in host trust store.\n` +
        `You can retry manually with "lo1 tls-setup".\n` +
        `Detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
