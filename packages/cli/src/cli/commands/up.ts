import { Command } from "commander";
import { startWorkspace } from "../../orchestrator/start";
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
    case "output":
      return `[${event.line.service}] ${event.line.text}`;
    case "error":
      return `[error] ${event.message}`;
  }
}

export const upCommand = new Command("up")
  .description("Start all services and infrastructure")
  .option("--services <names>", "Comma-separated list of services to start")
  .option("--mode <mode>", "Override service mode (dev|container)")
  .option("--headless", "Run in headless mode (no TUI)")
  .action(async (options) => {
    const controller = new AbortController();

    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());

    const serviceFilter = options.services
      ? (options.services as string).split(",").map((s: string) => s.trim())
      : undefined;

    const modeOverride = options.mode as "dev" | "container" | undefined;

    const onEvent = (event: OrchestratorEvent) => {
      const msg = formatEvent(event);
      if (msg) process.stdout.write(msg.trimEnd() + "\n");
    };

    let result: Awaited<ReturnType<typeof startWorkspace>> | undefined;
    try {
      result = await startWorkspace({
        workspaceDir: process.cwd(),
        serviceFilter,
        modeOverride,
        signal: controller.signal,
        onEvent,
      });

      // Keep process alive until abort signal
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    }

    // Graceful shutdown — no signal passed so shutdown runs to completion
    onEvent({ kind: "phase", phase: "Shutting down..." });
    try {
      await stopWorkspace({
        workspaceDir: process.cwd(),
        handles: result?.handles,
        onEvent,
      });
    } catch {
      // Best-effort shutdown
    }
  });
