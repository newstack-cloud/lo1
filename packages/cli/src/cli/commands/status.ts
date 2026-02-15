import { Command } from "commander";
import { readState } from "../../orchestrator/state";
import { composePs } from "../../runner/compose";

export const statusCommand = new Command("status")
  .description("Show status of all services")
  .action(async () => {
    try {
      const state = await readState(process.cwd());
      if (!state) {
        console.log("No running workspace found.");
        return;
      }

      console.log(`Workspace: ${state.workspaceName}`);
      console.log(`Project:   ${state.projectName}\n`);

      const statuses = await composePs({
        projectName: state.projectName,
        fileArgs: state.fileArgs,
        cwd: state.workspaceDir,
      });

      if (statuses.length === 0) {
        console.log("No infrastructure services running.");
        return;
      }

      console.log("Infrastructure:");
      for (const s of statuses) {
        const health = s.Health ? ` (${s.Health})` : "";
        console.log(`  ${s.Service.padEnd(24)} ${s.State}${health}`);
      }

      const serviceEntries = Object.entries(state.services);
      if (serviceEntries.length > 0) {
        console.log("\nServices:");
        for (const [name, svc] of serviceEntries) {
          console.log(`  ${name.padEnd(24)} ${svc.runner}`);
        }
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
