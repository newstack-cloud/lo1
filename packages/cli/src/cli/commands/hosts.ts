import { Command } from "commander";

export const hostsCommand = new Command("hosts")
  .description("Manage /etc/hosts entries for local domains")
  .option("--apply", "Write managed block to /etc/hosts (requires sudo)")
  .option("--remove", "Remove managed block from /etc/hosts (requires sudo)")
  .action(async (options) => {
    if (options.apply) {
      console.log("Applying hosts entries...");
    } else if (options.remove) {
      console.log("Removing hosts entries...");
    } else {
      console.log("Current hosts entries:");
    }
    // TODO: L3 — hosts file management
  });
