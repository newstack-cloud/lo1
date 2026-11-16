import { describe, it, expect } from "bun:test";
import { createServer, type Server } from "node:net";
import type { WorkspaceConfig } from "@lo1/sdk";
import {
  collectPortClaims,
  findPortConflicts,
  isPortInUse,
  PortConflictError,
} from "../../src/doctor/ports";

function makeConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    version: "1",
    name: "shop",
    services: {
      api: { type: "service", path: "./api", port: 3000, mode: "dev", dependsOn: [], initTask: false },
      db: {
        type: "service",
        path: "./db",
        port: 5432,
        hostPort: 15432,
        mode: "container",
        containerImage: "postgres:17",
        dependsOn: [],
        initTask: false,
      },
      off: { type: "service", path: "./off", port: 9999, mode: "skip", dependsOn: [], initTask: false },
    },
    ...overrides,
  };
}

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

describe("collectPortClaims", () => {
  it("should claim the proxy port, dev ports and container host ports, skipping skip-mode", () => {
    const claims = collectPortClaims(makeConfig());

    expect(claims).toEqual([
      { port: 80, owner: "the proxy", setting: "proxy.port" },
      { port: 3000, owner: 'service "api"', setting: "services.api.port" },
      { port: 15432, owner: 'service "db"', setting: "services.db.hostPort" },
    ]);
  });

  it("should claim the TLS port and leave out the proxy when it is disabled", () => {
    const withTls = collectPortClaims(
      makeConfig({ proxy: { enabled: true, port: 8080, tld: "local", tls: { enabled: true, port: 8443, mode: "internal" } } }),
    );
    expect(withTls.slice(0, 2).map((c) => c.port)).toEqual([8080, 8443]);

    const noProxy = collectPortClaims(makeConfig({ proxy: { enabled: false, port: 80, tld: "local" } }));
    expect(noProxy.some((c) => c.owner === "the proxy")).toBe(false);
  });
});

describe("findPortConflicts", () => {
  it("should return only the claims whose ports are in use", async () => {
    const conflicts = await findPortConflicts(makeConfig(), async (port) => port === 3000);

    expect(conflicts).toEqual([{ port: 3000, owner: 'service "api"', setting: "services.api.port" }]);
  });
});

describe("isPortInUse", () => {
  it("should detect a listening port and a free one", async () => {
    const { server, port } = await listen();
    try {
      expect(await isPortInUse(port)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await isPortInUse(port)).toBe(false);
  });
});

describe("PortConflictError", () => {
  it("should name each port, its owner and the setting to change", () => {
    const err = new PortConflictError([
      { port: 3000, owner: 'service "api"', setting: "services.api.port" },
    ]);

    expect(err.message).toBe(
      "Can't start: a port lo1 needs is already in use.\n" +
        '  - Port 3000 is already in use, but service "api" needs it (services.api.port)\n' +
        "Stop whatever is using it, or change the setting in lo1.yaml.",
    );
    expect(err.toJSON()).toMatchObject({ error: "PortConflictError", ports: [3000] });
  });
});
