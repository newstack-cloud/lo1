import type { OrchestratorEvent } from "../orchestrator/types";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const SERVICE_PALETTE = [
  "\x1b[32m", // green
  "\x1b[34m", // blue
  "\x1b[35m", // magenta
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[92m", // bright green
  "\x1b[94m", // bright blue
  "\x1b[95m", // bright magenta
];

export type EventFormatter = (event: OrchestratorEvent) => string | null;

export function createEventFormatter(): EventFormatter {
  const useColor = process.stdout.isTTY === true;
  const serviceColors = new Map<string, string>();
  let colorIdx = 0;

  function color(code: string, text: string): string {
    return useColor ? `${code}${text}${RESET}` : text;
  }

  function serviceColor(name: string): string {
    let c = serviceColors.get(name);
    if (!c) {
      c = SERVICE_PALETTE[colorIdx % SERVICE_PALETTE.length];
      colorIdx++;
      serviceColors.set(name, c);
    }
    return c;
  }

  return (event) => {
    switch (event.kind) {
      case "phase":
        return `${color(CYAN + BOLD, "[lo1]")} ${event.phase}`;
      case "service":
        return `${color(CYAN + BOLD, "[lo1]")} ${event.service}: ${event.status}`;
      case "hook":
        return `${color(YELLOW, "[hook]")} ${event.output.text}`;
      case "output":
        return `${color(serviceColor(event.line.service), `[${event.line.service}]`)} ${event.line.text}`;
      case "error":
        return `${color(RED, "[error]")} ${event.message}`;
    }
  };
}
