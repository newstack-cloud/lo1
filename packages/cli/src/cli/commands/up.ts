import { Command } from "commander";

export const upCommand = new Command("up")
  .description("Start all services and infrastructure")
  .option("--services <names>", "Comma-separated list of services to start")
  .option("--mode <mode>", "Override service mode (dev|container)")
  .option("--headless", "Run in headless mode (no TUI)")
  .action(async (options) => {
    console.log("Starting lo1...", options);
    // TODO: L5 — orchestrator startup sequence
  });
