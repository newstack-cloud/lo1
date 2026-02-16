import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initLogDir, appendLog, logDir } from "../../src/logs/writer";

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "lo1-logs-test-"));
});

describe("initLogDir", () => {
  it("should create .lo1/logs/ directory", async () => {
    await initLogDir(workspaceDir);

    const entries = await readdir(logDir(workspaceDir));
    expect(entries).toEqual([]);
  });

  it("should clear existing log files on re-init", async () => {
    await initLogDir(workspaceDir);
    await appendLog(workspaceDir, "api", "first run");

    await initLogDir(workspaceDir);

    const entries = await readdir(logDir(workspaceDir));
    expect(entries).toEqual([]);
  });
});

describe("appendLog", () => {
  it("should create a log file and append a timestamped line", async () => {
    await initLogDir(workspaceDir);
    await appendLog(workspaceDir, "api", "server started on port 3000");

    const content = await readFile(join(logDir(workspaceDir), "api.log"), "utf-8");
    expect(content).toMatch(/^\[.+\] server started on port 3000\n$/);
  });

  it("should append multiple lines to the same file", async () => {
    await initLogDir(workspaceDir);
    await appendLog(workspaceDir, "api", "line 1");
    await appendLog(workspaceDir, "api", "line 2");

    const content = await readFile(join(logDir(workspaceDir), "api.log"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("line 1");
    expect(lines[1]).toContain("line 2");
  });

  it("should write to separate files per category", async () => {
    await initLogDir(workspaceDir);
    await appendLog(workspaceDir, "api", "api log");
    await appendLog(workspaceDir, "infrastructure", "infra log");

    const entries = await readdir(logDir(workspaceDir));
    expect(entries.sort()).toEqual(["api.log", "infrastructure.log"]);
  });
});

describe("logDir", () => {
  it("should return .lo1/logs path under workspace dir", () => {
    expect(logDir("/my/workspace")).toBe(join("/my/workspace", ".lo1", "logs"));
  });
});
