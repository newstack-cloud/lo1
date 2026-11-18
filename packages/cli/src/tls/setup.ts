import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("proxy");

const defaultExec = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type TlsDeps = {
  exec: ExecFn;
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  hash: (content: string) => string;
  platform: string;
  homeDir: string;
  exists: (path: string) => Promise<boolean>;
  /** Returns the entries of a directory, or none when it doesn't exist. */
  listDir: (path: string) => Promise<string[]>;
  maxCertRetries: number;
  certRetryIntervalMs: number;
};

export class TlsError extends Lo1Error {
  constructor(message: string) {
    super(message, "TlsError");
    this.name = "TlsError";
  }
}

const CA_CERT_PATH = "/data/caddy/pki/authorities/local/root.crt";
const CERT_FILE = "caddy-root.crt";
const HASH_FILE = "caddy-root.crt.sha256";

export const NSS_TOOLS_HINT =
  "Install certutil (Debian and Ubuntu: sudo apt install libnss3-tools; " +
  "Fedora: sudo dnf install nss-tools; Arch: sudo pacman -S nss), then run lo1 tls-setup.";

/** `warning` is set when the CA was trusted only in part, saying what to do about it. */
export type TrustResult = { warning?: string };

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
    homeDir: homedir(),
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    listDir: (path) => readdir(path).catch(() => []),
    maxCertRetries: 30,
    certRetryIntervalMs: 2000,
  };
}

/**
 * Extracts Caddy's root CA from the container, installs it in the host
 * trust store, and caches a hash so subsequent runs are skipped when
 * the cert hasn't changed. On Linux it also adds the CA to the NSS databases
 * Chrome and Firefox use, since neither reads the system store.
 */
export async function trustCaddyCa(
  containerName = "lo1-proxy",
  workspaceDir = ".",
  overrides: Partial<TlsDeps> = {},
): Promise<TrustResult> {
  debug("trustCaddyCa: container=%s", containerName);
  const deps = { ...createDefaultDeps(), ...overrides };
  const certDir = join(workspaceDir, ".lo1");
  const certPath = join(certDir, CERT_FILE);
  const hashPath = join(certDir, HASH_FILE);

  const cert = await extractCaCert(containerName, deps);
  // The suffix makes Linux installs cached before browser stores were covered run again.
  const certHash = deps.hash(cert) + (deps.platform === "linux" ? "+nss" : "");

  const cachedHash = await deps.readFile(hashPath);
  if (cachedHash && cachedHash.trim() === certHash) {
    debug("trustCaddyCa: cache hit, skipping install");
    return {};
  }
  debug("trustCaddyCa: cache miss, installing cert");

  await deps.mkdir(certDir);
  await deps.writeFile(certPath, cert);
  await installOnHost(certPath, deps);
  const result =
    deps.platform === "linux"
      ? await installInNssDatabases(certPath, `lo1 ${containerName}`, deps)
      : {};
  // Left uncached on a partial install, so the next run tries again.
  if (!result.warning) await deps.writeFile(hashPath, certHash);
  return result;
}

async function extractCaCert(containerName: string, deps: TlsDeps): Promise<string> {
  for (let attempt = 1; attempt <= deps.maxCertRetries; attempt++) {
    try {
      const { stdout } = await deps.exec("docker", ["exec", containerName, "cat", CA_CERT_PATH]);
      return stdout;
    } catch {
      if (attempt === deps.maxCertRetries) break;
      await new Promise((r) => setTimeout(r, deps.certRetryIntervalMs));
    }
  }
  throw new TlsError(
    `Failed to extract Caddy CA certificate after ${deps.maxCertRetries} attempts. ` +
      `Is the proxy container "${containerName}" running?`,
  );
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

function isMissingCommand(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Chrome, Chromium and other Chromium browsers share ~/.pki/nssdb (the snap
 * Chromium has its own), and each Firefox profile has its own database.
 */
async function findNssDatabases(deps: TlsDeps): Promise<string[]> {
  const home = deps.homeDir;
  const databases = [join(home, ".pki", "nssdb")];

  const snapChromium = join(home, "snap", "chromium", "current", ".pki", "nssdb");
  if (await deps.exists(snapChromium)) databases.push(snapChromium);

  const firefoxRoots = [
    join(home, ".mozilla", "firefox"),
    join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
  ];
  for (const root of firefoxRoots) {
    for (const entry of await deps.listDir(root)) {
      const profile = join(root, entry);
      if (await deps.exists(join(profile, "cert9.db"))) databases.push(profile);
    }
  }
  return databases;
}

async function installInNssDatabases(
  certPath: string,
  nickname: string,
  deps: TlsDeps,
): Promise<TrustResult> {
  const databases = await findNssDatabases(deps);
  try {
    // Chrome creates ~/.pki/nssdb on first launch; create it now so a browser
    // opened for the first time after lo1 up still trusts the CA.
    const chromeDb = databases[0];
    if (!(await deps.exists(join(chromeDb, "cert9.db")))) {
      await deps.mkdir(chromeDb);
      await deps.exec("certutil", ["-d", `sql:${chromeDb}`, "-N", "--empty-password"]);
    }
    for (const db of databases) await addToNssDatabase(db, certPath, nickname, deps);
    return {};
  } catch (err) {
    if (isMissingCommand(err)) {
      return {
        warning:
          "Trusted the local CA system-wide, but not in Chrome or Firefox, " +
          `which need certutil to add it to their own stores. ${NSS_TOOLS_HINT}`,
      };
    }
    throw new TlsError(
      `Failed to add Caddy CA to the browser certificate stores.\n` +
        `You can retry manually with "lo1 tls-setup".\n` +
        `Detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function addToNssDatabase(
  db: string,
  certPath: string,
  nickname: string,
  deps: TlsDeps,
): Promise<void> {
  const dbArg = `sql:${db}`;
  // Replaces this workspace's CA from an earlier proxy volume; fails harmlessly when there is none.
  await deps.exec("certutil", ["-d", dbArg, "-D", "-n", nickname]).catch((err: unknown) => {
    if (isMissingCommand(err)) throw err;
  });
  await deps.exec("certutil", ["-d", dbArg, "-A", "-t", "C,,", "-n", nickname, "-i", certPath]);
}
