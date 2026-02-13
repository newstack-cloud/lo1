import { Command } from "commander";

export const downCommand = new Command("down")
  .description("Stop all services and infrastructure")
  .action(async () => {
    console.log("Stopping lo1...");
    // TODO: L5 — orchestrator shutdown sequence
  });
