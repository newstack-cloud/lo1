import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { trustCaddyCa, TlsError } from "../../tls/setup";
import { readState } from "../../orchestrator/state";
import type { WorkspaceState } from "../../orchestrator/types";

export type TlsSetupDeps = {
  readState: (workspaceDir: string) => Promise<WorkspaceState | null>;
  trustCaddyCa: (containerName: string, workspaceDir: string) => Promise<void>;
  removeHashFile: (hashPath: string) => Promise<void>;
};

function createDefaultDeps(): TlsSetupDeps {
  return {
    readState,
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

export async function runTlsSetup(
  workspaceDir: string,
  overrides: Partial<TlsSetupDeps> = {},
): Promise<void> {
  const deps = { ...createDefaultDeps(), ...overrides };

  const state = await deps.readState(workspaceDir);
  if (!state) {
    throw new TlsError('No running workspace found. Run "lo1 up" first.');
  }

  const containerName = `${state.projectName}-proxy`;
  const hashPath = join(workspaceDir, ".lo1", "caddy-root.crt.sha256");
  await deps.removeHashFile(hashPath);
  await deps.trustCaddyCa(containerName, workspaceDir);
}

export const tlsSetupCommand = new Command("tls-setup")
  .description("Trust Caddy's local CA so browsers accept TLS certificates without warnings")
  .action(async () => {
    try {
      console.log("Installing Caddy root CA into host trust store...");
      await runTlsSetup(process.cwd());
      console.log("Done. Browsers will now trust local TLS certificates.");
    } catch (err) {
      if (err instanceof TlsError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  });
