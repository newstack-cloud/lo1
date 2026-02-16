#!/usr/bin/env node
import { Command } from "commander";
import { Lo1Error } from "../errors";
import { initCommand } from "./commands/init";
import { upCommand } from "./commands/up";
import { downCommand } from "./commands/down";
import { statusCommand } from "./commands/status";
import { hostsCommand } from "./commands/hosts";
import { tlsSetupCommand } from "./commands/tls-setup";
import { logsCommand } from "./commands/logs";

export const program = new Command();

program
  .name("lo1")
  .description("Multi-service local dev environment")
  .version("0.1.0")
  .option("--json", "Output machine-readable JSON");

program.addCommand(initCommand);
program.addCommand(upCommand);
program.addCommand(downCommand);
program.addCommand(statusCommand);
program.addCommand(hostsCommand);
program.addCommand(tlsSetupCommand);
program.addCommand(logsCommand);

export function formatErrorForOutput(err: unknown, json: boolean): string {
  if (json) {
    const payload =
      err instanceof Lo1Error
        ? err.toJSON()
        : { error: "UnknownError", message: err instanceof Error ? err.message : String(err) };
    return JSON.stringify(payload);
  }
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  try {
    await program.parseAsync();
  } catch (err) {
    const json = program.opts().json === true;
    if (json) {
      process.stdout.write(formatErrorForOutput(err, true) + "\n");
    } else {
      console.error(formatErrorForOutput(err, false));
    }
    process.exitCode = 1;
  }
}
