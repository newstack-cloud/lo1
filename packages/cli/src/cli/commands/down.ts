import { Command } from "commander";
import { stopWorkspace } from "../../orchestrator/stop";
import { createEventFormatter } from "../../output/format";
import type { OrchestratorEvent } from "../../orchestrator/types";

export const downCommand = new Command("down")
  .description("Stop all services and infrastructure")
  .option("--clean", "Remove volumes and orphan containers")
  .action(async (options) => {
    const formatEvent = createEventFormatter();
    const onEvent = (event: OrchestratorEvent) => {
      const msg = formatEvent(event);
      if (msg) process.stdout.write(msg.trimEnd() + "\n");
    };

    await stopWorkspace({
      workspaceDir: process.cwd(),
      clean: options.clean === true,
      onEvent,
    });
  });
