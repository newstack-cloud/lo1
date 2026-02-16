import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { platform } from "node:os";
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

function writePrivileged(filePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = platform() === "win32";

    // Use absolute paths to avoid using an untrusted search path
    const proc = isWindows
      ? spawn(
          join(
            process.env.SYSTEMROOT ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          ["-Command", `Set-Content -Path '${filePath}' -Value $input -Encoding ASCII`],
          { stdio: ["pipe", "ignore", "pipe"] },
        )
      : spawn("/usr/bin/sudo", ["tee", filePath], {
          stdio: ["pipe", "ignore", "pipe"],
        });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new HostsError(`Failed to write ${filePath}: ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      reject(new HostsError(`Failed to write ${filePath}: ${err.message}`));
    });

    proc.stdin.write(content);
    proc.stdin.end();
  });
}
