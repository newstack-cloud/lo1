import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import type { WorkspaceConfig } from "@lo1/sdk";
import { trustCaddyCa, TlsError, type TrustResult } from "../../tls/setup";
import { isAcmeTls } from "../../tls/acme";
import { readState } from "../../orchestrator/state";
import { loadWorkspaceConfig } from "../../config/loader";
import type { WorkspaceState } from "../../orchestrator/types";

export type TlsSetupDeps = {
  readState: (workspaceDir: string) => Promise<WorkspaceState | null>;
  /** Returns null when the workspace has no readable config. */
  loadConfig: (workspaceDir: string) => Promise<WorkspaceConfig | null>;
  trustCaddyCa: (containerName: string, workspaceDir: string) => Promise<TrustResult | void>;
  removeHashFile: (hashPath: string) => Promise<void>;
};

function createDefaultDeps(): TlsSetupDeps {
  return {
    readState,
    loadConfig: async (workspaceDir) => {
      try {
        return await loadWorkspaceConfig(join(workspaceDir, "lo1.yaml"));
      } catch {
        return null;
      }
    },
    trustCaddyCa,
    removeHashFile: async (hashPath) => {
      try {
        await unlink(hashPath);
      } catch {
        // Ignore if file doesn't exist
      }
    },
  };
}

export type TlsSetupResult = { trusted: boolean; reason?: string; warning?: string };

export async function runTlsSetup(
  workspaceDir: string,
  overrides: Partial<TlsSetupDeps> = {},
): Promise<TlsSetupResult> {
  const deps = { ...createDefaultDeps(), ...overrides };

  const config = await deps.loadConfig(workspaceDir);
  if (config && isAcmeTls(config)) {
    return {
      trusted: false,
      reason:
        "This workspace issues publicly trusted certificates over ACME, " +
        "so there is no local CA to install.",
    };
  }

  const state = await deps.readState(workspaceDir);
  if (!state) {
    throw new TlsError('No running workspace found. Run "lo1 up" first.');
  }

  const containerName = `${state.projectName}-proxy`;
  const hashPath = join(workspaceDir, ".lo1", "caddy-root.crt.sha256");
  await deps.removeHashFile(hashPath);
  const trust = await deps.trustCaddyCa(containerName, workspaceDir);
  return { trusted: true, warning: trust?.warning };
}

export const tlsSetupCommand = new Command("tls-setup")
  .description("Trust Caddy's local CA so browsers accept TLS certificates without warnings")
  .action(async () => {
    const result = await runTlsSetup(process.cwd());
    if (!result.trusted) {
      console.log(`Nothing to do. ${result.reason}`);
      return;
    }
    if (result.warning) {
      console.log(result.warning);
      return;
    }
    console.log("Done. Browsers will now trust local TLS certificates.");
  });
