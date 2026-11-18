import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("proxy");

export class HostsError extends Lo1Error {
  constructor(message: string) {
    super(message, "HostsError");
    this.name = "HostsError";
  }
}

const MARKER_START = "# lo1-start";
const MARKER_END = "# lo1-end";

export function getHostsFilePath(): string {
  if (platform() === "win32") {
    return join("C:", "Windows", "System32", "drivers", "etc", "hosts");
  }
  return "/etc/hosts";
}

export function generateHostsBlock(domains: string[]): string {
  if (domains.length === 0) return "";

  const domainList = domains.join(" ");
  const lines = [MARKER_START, `127.0.0.1 ${domainList}`, `::1 ${domainList}`, MARKER_END];
  return lines.join("\n") + "\n";
}

export function replaceHostsBlock(currentContent: string, block: string): string {
  const startIdx = currentContent.indexOf(MARKER_START);
  const endIdx = currentContent.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = currentContent.slice(0, startIdx);
    const after = currentContent.slice(endIdx + MARKER_END.length + 1);
    return before + block + after;
  }

  const separator = currentContent.endsWith("\n") ? "" : "\n";
  return currentContent + separator + block;
}

export function removeHostsBlock(currentContent: string): string {
  const startIdx = currentContent.indexOf(MARKER_START);
  const endIdx = currentContent.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) return currentContent;

  const before = currentContent.slice(0, startIdx);
  const after = currentContent.slice(endIdx + MARKER_END.length + 1);
  return before + after;
}

export async function applyHosts(block: string): Promise<void> {
  debug("applyHosts: writing hosts block (%d bytes)", block.length);
  await modifyHostsFile((content) => replaceHostsBlock(content, block));
}

export async function removeHosts(): Promise<void> {
  debug("removeHosts: clearing lo1 hosts block");
  await modifyHostsFile(removeHostsBlock);
}

async function modifyHostsFile(transform: (content: string) => string): Promise<void> {
  const hostsPath = getHostsFilePath();
  let current: string;
  try {
    current = await readFile(hostsPath, "utf-8");
  } catch {
    throw new HostsError(`Could not read hosts file: ${hostsPath}`);
  }

  const updated = transform(current);
  await writePrivileged(hostsPath, updated);
}

function isPermissionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return err.code === "EPERM" || err.code === "EACCES";
}

function windowsPowerShellPath(): string {
  // An absolute path, so a powershell.exe earlier on PATH can't stand in for it.
  return join(
    process.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Builds a PowerShell command that copies `source` over `destination` in an
 * elevated PowerShell, so Windows shows a UAC prompt, and exits with its exit
 * code. The inner command is base64-encoded so paths need only one level of quoting.
 */
export function buildElevatedCopyCommand(
  source: string,
  destination: string,
  powershell: string,
): string {
  const copy = `Copy-Item -LiteralPath ${quotePowerShell(source)} -Destination ${quotePowerShell(destination)} -Force -ErrorAction Stop`;
  const encoded = Buffer.from(copy, "utf16le").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded].map(quotePowerShell);
  return (
    `$p = Start-Process -FilePath ${quotePowerShell(powershell)} -Verb RunAs -Wait -PassThru ` +
    `-WindowStyle Hidden -ArgumentList ${args.join(",")}; exit $p.ExitCode`
  );
}

/**
 * Writes the hosts file directly when lo1 runs as Administrator, and otherwise
 * copies it into place from an elevated PowerShell after a UAC prompt.
 */
async function writeWindowsHosts(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, "utf-8");
    return;
  } catch (err) {
    if (!isPermissionError(err)) {
      throw new HostsError(`Failed to write ${filePath}: ${(err as Error).message}`);
    }
  }

  debug("writeWindowsHosts: not elevated, asking for administrator rights");
  console.error("lo1 needs administrator rights to update the hosts file.\n");
  const dir = await mkdtemp(join(tmpdir(), "lo1-hosts-"));
  const staged = join(dir, "hosts");
  try {
    await writeFile(staged, content, "utf-8");
    const powershell = windowsPowerShellPath();
    const command = buildElevatedCopyCommand(staged, filePath, powershell);
    await runWithStdin(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], "");
  } catch (err) {
    throw new HostsError(
      `Failed to write ${filePath}: ${(err as Error).message}\n` +
        "Accept the administrator prompt, or run lo1 from a PowerShell opened as Administrator.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePrivileged(filePath: string, content: string): Promise<void> {
  if (platform() === "win32") return writeWindowsHosts(filePath, content);
  try {
    return await runWithStdin("/usr/bin/sudo", ["tee", filePath], content);
  } catch (err) {
    throw new HostsError(`Failed to write ${filePath}: ${(err as Error).message}`);
  }
}

function runWithStdin(cmd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);

    proc.stdin.write(input);
    proc.stdin.end();
  });
}
