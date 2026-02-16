import type { WorkspaceConfig } from "@lo1/sdk";
import { Lo1Error } from "../errors";

export class FilterError extends Lo1Error {
  constructor(message: string) {
    super(message, "FilterError");
    this.name = "FilterError";
  }
}

export function resolveServiceFilter(requested: string[], config: WorkspaceConfig): Set<string> {
  for (const name of requested) {
    if (!(name in config.services)) {
      throw new FilterError(`Unknown service "${name}" in --services filter`);
    }
  }

  const result = new Set<string>();
  const queue = [...requested];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (result.has(name)) continue;

    result.add(name);
    for (const dep of config.services[name].dependsOn) {
      if (!result.has(dep)) {
        queue.push(dep);
      }
    }
  }

  return result;
}
