import { Command } from "commander";
import { loadWorkspaceConfig, ConfigError } from "../../config/loader";
import { initRepositories } from "../../repos/init";

export const initCommand = new Command("init")
  .description("Initialize workspace — clone repositories defined in lo1.yaml")
  .option("--config <path>", "Path to lo1.yaml config file", "lo1.yaml")
  .action(async (options) => {
    try {
      const config = await loadWorkspaceConfig(options.config);
      console.log(`Workspace: ${config.name}`);

      if (!config.repositories || Object.keys(config.repositories).length === 0) {
        console.log("No repositories defined — nothing to clone.");
        return;
      }

      console.log("Cloning repositories...");
      const result = await initRepositories(config);

      for (const r of result.results) {
        if (r.error) {
          console.error(`  ✗ ${r.name}: ${r.error.message}`);
        } else if (r.cloned) {
          console.log(`  ✓ ${r.name} → ${r.path}`);
        } else {
          console.log(`  - ${r.name} (already exists)`);
        }
      }

      console.log(
        `\nDone: ${result.clonedCount} cloned, ${result.skippedCount} skipped, ${result.failedCount} failed`,
      );

      if (result.failedCount > 0) {
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  });
