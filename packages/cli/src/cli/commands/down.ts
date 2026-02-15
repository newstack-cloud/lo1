import { Command } from "commander";
import { stopWorkspace } from "../../orchestrator/stop";
import type { OrchestratorEvent } from "../../orchestrator/types";

function formatEvent(event: OrchestratorEvent): string | null {
  switch (event.kind) {
    case "phase":
      return `[lo1] ${event.phase}`;
    case "service":
      return `[lo1] ${event.service}: ${event.status}`;
    case "hook":
      return `[hook] ${event.output.text}`;
    case "error":
      return `[error] ${event.message}`;
    case "output":
      return null;
  }
}

export const downCommand = new Command("down")
  .description("Stop all services and infrastructure")
  .action(async () => {
    const onEvent = (event: OrchestratorEvent) => {
      const msg = formatEvent(event);
      if (msg) process.stdout.write(msg.trimEnd() + "\n");
    };

    try {
      await stopWorkspace({
        workspaceDir: process.cwd(),
        onEvent,
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
