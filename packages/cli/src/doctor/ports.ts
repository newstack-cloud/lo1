import { connect } from "node:net";
import type { WorkspaceConfig } from "@lo1/sdk";
import { Lo1Error } from "../errors";

/** A host port lo1 will need, and what needs it. */
export type PortClaim = {
  port: number;
  owner: string;
  /** The lo1.yaml field that changes this port. */
  setting: string;
};

export type PortProbe = (port: number) => Promise<boolean>;

export class PortConflictError extends Lo1Error {
  constructor(public readonly conflicts: PortClaim[]) {
    super(formatPortConflicts(conflicts), "PortConflictError", {
      ports: conflicts.map((c) => c.port),
    });
    this.name = "PortConflictError";
  }
}

/** The host ports a workspace binds: the proxy's, then each running service's. */
export function collectPortClaims(config: WorkspaceConfig): PortClaim[] {
  const claims: PortClaim[] = [];

  if (config.proxy?.enabled !== false) {
    claims.push({ port: config.proxy?.port ?? 80, owner: "the proxy", setting: "proxy.port" });
    if (config.proxy?.tls?.enabled) {
      claims.push({
        port: config.proxy.tls.port ?? 443,
        owner: "the proxy",
        setting: "proxy.tls.port",
      });
    }
  }

  for (const [name, service] of Object.entries(config.services)) {
    if (service.mode === "skip" || !service.port) continue;

    const isContainer = service.mode === "container";
    claims.push({
      port: isContainer ? (service.hostPort ?? service.port) : service.port,
      owner: `service "${name}"`,
      setting: isContainer ? `services.${name}.hostPort` : `services.${name}.port`,
    });
  }

  return claims;
}

/**
 * Reports whether something accepts connections on the port on this machine.
 * Connecting rather than binding avoids false alarms for ports below 1024,
 * which an unprivileged process may not bind even when they are free.
 */
export async function isPortInUse(port: number, timeoutMs = 500): Promise<boolean> {
  const results = await Promise.all(
    ["127.0.0.1", "::1"].map((host) => acceptsConnections(host, port, timeoutMs)),
  );
  return results.some(Boolean);
}

function acceptsConnections(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function findPortConflicts(
  config: WorkspaceConfig,
  probe: PortProbe = isPortInUse,
): Promise<PortClaim[]> {
  const claims = collectPortClaims(config);
  const inUse = await Promise.all(claims.map((claim) => probe(claim.port)));
  return claims.filter((_, i) => inUse[i]);
}

export function formatPortConflict(claim: PortClaim): string {
  return `Port ${claim.port} is already in use, but ${claim.owner} needs it`;
}

function formatPortConflicts(conflicts: PortClaim[]): string {
  const lines = conflicts.map((c) => `  - ${formatPortConflict(c)} (${c.setting})`);
  return (
    `Can't start: ${conflicts.length === 1 ? "a port lo1 needs is" : "ports lo1 needs are"} ` +
    `already in use.\n${lines.join("\n")}\n` +
    `Stop whatever is using ${conflicts.length === 1 ? "it" : "them"}, ` +
    `or change the setting in lo1.yaml.`
  );
}
