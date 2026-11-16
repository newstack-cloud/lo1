import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkspaceConfig } from "@lo1/sdk";
import {
  buildReadyJson,
  formatReadySummary,
  recordedHandle,
  recordReplacement,
} from "../../src/cli/commands/up";
import { readState, writeState } from "../../src/orchestrator/state";

const config: WorkspaceConfig = {
  version: "1",
  name: "shop",
  proxy: { enabled: true, port: 80, tld: "local", tls: { enabled: true, port: 443, mode: "internal" } },
  services: {
    api: { type: "service", path: "./api", port: 3000, mode: "dev", dependsOn: [], initTask: false },
    migrate: { type: "service", path: "./api", mode: "dev", dependsOn: [], initTask: true },
    web: {
      type: "app",
      path: "./web",
      port: 5173,
      mode: "dev",
      dependsOn: ["api"],
      initTask: false,
      proxy: { domain: ["shop.example.test", "www.shop.example.test"] },
    },
  },
};

const result = {
  config,
  timings: {
    totalMs: 11_430,
    phases: [
      { name: "infrastructure", ms: 4_210 },
      { name: "services", ms: 6_080 },
    ],
  },
};

describe("formatReadySummary", () => {
  it("should show the total time, the phase breakdown and each service URL", () => {
    const text = formatReadySummary(result, "/ws", true);

    expect(text).toBe(
      [
        "",
        "  Workspace shop is ready in 11.4s",
        "    infrastructure 4.2s · services 6.1s",
        "",
        "  Services:",
        "    api  https://api.shop.local",
        "    web  https://shop.example.test",
        "",
        `  Logs:  ${join("/ws", ".lo1", "logs")}`,
        "         Run lo1 logs [service] to tail, lo1 logs --list to see available",
        "",
        "  Run lo1 down to stop",
        "",
      ].join("\n"),
    );
  });

  it("should tell a foreground run how to stop", () => {
    expect(formatReadySummary(result, "/ws", false)).toContain("  Press Ctrl+C to stop\n");
  });
});

describe("buildReadyJson", () => {
  it("should describe the ready workspace for scripts and agents", () => {
    expect(buildReadyJson(result, "/ws", true)).toEqual({
      workspace: "shop",
      ready: true,
      detached: true,
      durationMs: 11_430,
      phases: result.timings.phases,
      services: [
        { name: "api", url: "https://api.shop.local" },
        { name: "web", url: "https://shop.example.test" },
      ],
      logs: join("/ws", ".lo1", "logs"),
    });
  });
});

describe("recordReplacement", () => {
  it("points the state file at the restarted process and keeps the other services", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lo1-up-"));
    await writeState(
      {
        workspaceName: "shop",
        projectName: "lo1-shop",
        fileArgs: [],
        workspaceDir: dir,
        services: {
          api: { runner: "process", pid: 100 },
          web: { runner: "process", pid: 200 },
        },
      },
      dir,
    );

    await recordReplacement(dir, {
      serviceName: "api",
      type: "process",
      pid: 300,
      running: true,
      stop: async () => {},
    });

    const state = await readState(dir);
    expect(state?.services).toEqual({
      api: { runner: "process", pid: 300 },
      web: { runner: "process", pid: 200 },
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("does nothing once the workspace is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lo1-up-"));

    await recordReplacement(dir, { serviceName: "api", type: "process", pid: 1, running: true, stop: async () => {} });

    expect(await readState(dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("recordedHandle", () => {
  it("returns the service's handle from the state file, or undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lo1-up-"));
    await writeState(
      {
        workspaceName: "shop",
        projectName: "lo1-shop",
        fileArgs: [],
        workspaceDir: dir,
        services: { api: { runner: "process", pid: 300 } },
      },
      dir,
    );

    const handle = await recordedHandle(dir, "api");

    expect(handle).toMatchObject({ serviceName: "api", type: "process", pid: 300 });
    expect(await recordedHandle(dir, "web")).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
