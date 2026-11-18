import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { WorkspaceConfig } from "@lo1/sdk";
import { loadWorkspaceConfig } from "../config/loader";
import { readState } from "../orchestrator/state";
import { collectDomains } from "../proxy/domains";
import { getHostsFilePath } from "../hosts/index";
import { getAcmeConfig, isAcmeTls, verifyAcmeEnv } from "../tls/acme";
import { NSS_TOOLS_HINT } from "../tls/setup";
import { findPortConflicts, formatPortConflict, isPortInUse, type PortProbe } from "./ports";

export type CheckStatus = "ok" | "warn" | "fail";

export type CheckResult = {
  id: string;
  status: CheckStatus;
  message: string;
  /** What to do about a warning or failure. */
  fix?: string;
};

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type DoctorDeps = {
  exec: ExecFn;
  nodeVersion: string;
  loadConfig: () => Promise<WorkspaceConfig>;
  configExists: () => Promise<boolean>;
  isWorkspaceRunning: (workspaceDir: string) => Promise<boolean>;
  readHostsFile: () => Promise<string>;
  probePort: PortProbe;
  env: NodeJS.ProcessEnv;
  platform: string;
};

export const MIN_NODE_MAJOR = 24;
const MIN_COMPOSE_MAJOR = 2;

export function createDefaultDoctorDeps(configPath = "lo1.yaml"): DoctorDeps {
  return {
    exec: promisify(execFile),
    nodeVersion: process.versions.node,
    loadConfig: () => loadWorkspaceConfig(configPath),
    configExists: () =>
      readFile(configPath).then(
        () => true,
        () => false,
      ),
    isWorkspaceRunning: async (dir) => (await readState(dir)) !== null,
    readHostsFile: () => readFile(getHostsFilePath(), "utf-8"),
    probePort: isPortInUse,
    env: process.env,
    platform: process.platform,
  };
}

function majorVersion(version: string): number {
  return Number.parseInt(version.replace(/^v/, "").split(".")[0], 10);
}

export function checkNode(nodeVersion: string): CheckResult {
  if (majorVersion(nodeVersion) >= MIN_NODE_MAJOR) {
    return { id: "node", status: "ok", message: `Node.js ${nodeVersion}` };
  }
  return {
    id: "node",
    status: "fail",
    message: `Node.js ${nodeVersion} is too old; lo1 needs ${MIN_NODE_MAJOR} or later`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} or later from https://nodejs.org`,
  };
}

function isMissingCommand(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

export async function checkDocker(exec: ExecFn): Promise<CheckResult> {
  try {
    const { stdout } = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    return { id: "docker", status: "ok", message: `Docker ${stdout.trim()}` };
  } catch (err) {
    if (isMissingCommand(err)) {
      return {
        id: "docker",
        status: "fail",
        message: "Docker is not installed",
        fix: "Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/",
      };
    }
    return {
      id: "docker",
      status: "fail",
      message: "Docker is installed, but the Docker daemon is not running",
      fix: "Start Docker Desktop, or on Linux run: sudo systemctl start docker",
    };
  }
}

export async function checkCompose(exec: ExecFn): Promise<CheckResult> {
  const fix = "Install Docker Compose v2: https://docs.docker.com/compose/install/";
  try {
    const { stdout } = await exec("docker", ["compose", "version", "--short"]);
    const version = stdout.trim();
    if (majorVersion(version) >= MIN_COMPOSE_MAJOR) {
      return { id: "compose", status: "ok", message: `Docker Compose ${version}` };
    }
    return {
      id: "compose",
      status: "fail",
      message: `Docker Compose ${version} is too old; lo1 needs v2`,
      fix,
    };
  } catch {
    return { id: "compose", status: "fail", message: "Docker Compose v2 was not found", fix };
  }
}

export async function checkGit(exec: ExecFn, needsGit: boolean): Promise<CheckResult> {
  try {
    const { stdout } = await exec("git", ["--version"]);
    const version = stdout.trim().replace(/^git version /, "");
    return { id: "git", status: "ok", message: `Git ${version}` };
  } catch {
    return {
      id: "git",
      status: needsGit ? "fail" : "warn",
      message: needsGit
        ? "Git is not installed, and lo1.yaml lists repositories for lo1 init to clone"
        : "Git is not installed; lo1 init needs it to clone repositories",
      fix: "Install Git: https://git-scm.com/downloads",
    };
  }
}

export function checkAcme(config: WorkspaceConfig, env: NodeJS.ProcessEnv): CheckResult | null {
  const acme = getAcmeConfig(config);
  if (!acme) return null;

  try {
    verifyAcmeEnv(acme, env);
    return { id: "acme", status: "ok", message: `ACME credentials for ${acme.provider} are set` };
  } catch (err) {
    const [message, ...rest] = (err as Error).message.split("\n");
    return { id: "acme", status: "fail", message, fix: rest.join(" ").trim() };
  }
}

/** On Linux, Chrome and Firefox only trust the local CA once certutil has added it to their stores. */
export async function checkBrowserTrust(
  config: WorkspaceConfig,
  exec: ExecFn,
  platform: string,
): Promise<CheckResult | null> {
  if (platform !== "linux") return null;
  if (!config.proxy?.tls?.enabled || isAcmeTls(config)) return null;

  try {
    await exec("certutil", ["-H"]);
  } catch (err) {
    // certutil -H exits non-zero after printing its help, so only a missing binary counts.
    if (isMissingCommand(err)) {
      return {
        id: "browser-trust",
        status: "warn",
        message: "certutil is not installed, so Chrome and Firefox won't trust the local CA",
        fix: NSS_TOOLS_HINT,
      };
    }
  }
  return {
    id: "browser-trust",
    status: "ok",
    message: "certutil is installed, so lo1 up can add the local CA to Chrome and Firefox",
  };
}

export async function checkPorts(
  config: WorkspaceConfig,
  probe: PortProbe,
  workspaceRunning: boolean,
): Promise<CheckResult[]> {
  if (workspaceRunning) {
    return [
      {
        id: "ports",
        status: "ok",
        message: "Ports not checked: this workspace is running (run lo1 down to check them)",
      },
    ];
  }

  const conflicts = await findPortConflicts(config, probe);
  if (conflicts.length === 0) {
    return [{ id: "ports", status: "ok", message: "All ports lo1 needs are free" }];
  }
  return conflicts.map((claim) => ({
    id: "ports",
    status: "fail" as const,
    message: formatPortConflict(claim),
    fix: `Stop whatever is listening on port ${claim.port}, or change ${claim.setting} in lo1.yaml`,
  }));
}

export async function checkHosts(
  config: WorkspaceConfig,
  readHostsFile: () => Promise<string>,
): Promise<CheckResult | null> {
  if (config.proxy?.enabled === false) return null;
  const domains = collectDomains(config);
  if (domains.length === 0) return null;

  let content: string;
  try {
    content = await readHostsFile();
  } catch {
    return {
      id: "hosts",
      status: "warn",
      message: "Could not read the hosts file",
      fix: "lo1 up adds the workspace's domains to it, and asks for sudo to do so",
    };
  }

  const listed = new Set(content.split(/\s+/));
  const missing = domains.filter((domain) => !listed.has(domain));
  if (missing.length === 0) {
    return {
      id: "hosts",
      status: "ok",
      message: `Hosts file lists all ${domains.length} domain(s)`,
    };
  }
  return {
    id: "hosts",
    status: "warn",
    message: `${missing.length} of ${domains.length} domain(s) are not in the hosts file yet`,
    fix: "lo1 up adds them and asks for sudo to do so; lo1 hosts --apply does it on its own",
  };
}

async function checkWorkspace(deps: DoctorDeps, workspaceDir: string): Promise<CheckResult[]> {
  if (!(await deps.configExists())) {
    return [
      {
        id: "config",
        status: "warn",
        message: "No lo1.yaml here, so workspace checks were skipped",
        fix: "Run lo1 doctor from your workspace root",
      },
    ];
  }

  let config: WorkspaceConfig;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    return [{ id: "config", status: "fail", message: (err as Error).message }];
  }

  const results: CheckResult[] = [
    { id: "config", status: "ok", message: `lo1.yaml is valid (workspace "${config.name}")` },
  ];
  const running = await deps.isWorkspaceRunning(workspaceDir);
  results.push(...(await checkPorts(config, deps.probePort, running)));

  const optional = [
    await checkHosts(config, deps.readHostsFile),
    checkAcme(config, deps.env),
    await checkBrowserTrust(config, deps.exec, deps.platform),
  ];
  for (const result of optional) if (result) results.push(result);

  return results;
}

export async function runDoctor(deps: DoctorDeps, workspaceDir = "."): Promise<CheckResult[]> {
  const needsGit = await deps
    .loadConfig()
    .then((c) => Object.keys(c.repositories ?? {}).length > 0)
    .catch(() => false);

  const [docker, compose, git] = await Promise.all([
    checkDocker(deps.exec),
    checkCompose(deps.exec),
    checkGit(deps.exec, needsGit),
  ]);

  return [
    checkNode(deps.nodeVersion),
    docker,
    compose,
    git,
    ...(await checkWorkspace(deps, workspaceDir)),
  ];
}
