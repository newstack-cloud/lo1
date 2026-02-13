import { Command } from "commander";

export const statusCommand = new Command("status")
  .description("Show status of all services")
  .action(async () => {
    console.log("lo1 status");
    // TODO: L5 — query running services
  });
