#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init";
import { upCommand } from "./commands/up";
import { downCommand } from "./commands/down";
import { statusCommand } from "./commands/status";
import { hostsCommand } from "./commands/hosts";
import { tlsSetupCommand } from "./commands/tls-setup";
import { logsCommand } from "./commands/logs";

export const program = new Command();

program.name("lo1").description("Multi-service local dev environment").version("0.1.0");

program.addCommand(initCommand);
program.addCommand(upCommand);
program.addCommand(downCommand);
program.addCommand(statusCommand);
program.addCommand(hostsCommand);
program.addCommand(tlsSetupCommand);
program.addCommand(logsCommand);

if (import.meta.main) {
  program.parse();
}
