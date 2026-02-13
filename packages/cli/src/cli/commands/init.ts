import { Command } from "commander";

export const initCommand = new Command("init")
  .description("Initialize workspace — clone repositories defined in lo1.yaml")
  .option("--config <path>", "Path to lo1.yaml config file", "lo1.yaml")
  .action(async (options) => {
    console.log(`Initializing workspace from ${options.config}...`);
    // TODO: L2 — config loading, repo cloning
  });
