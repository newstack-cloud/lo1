import type { WorkspaceConfig } from "@lo1/sdk";

export type ExecutionLayer = string[];

export type DagResult = {
  layers: ExecutionLayer[];
  serviceCount: number;
};

export class DagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
  }
}

export function buildDag(config: WorkspaceConfig): DagResult {
  const serviceNames = Object.keys(config.services);

  // Validate all dependency references exist
  for (const name of serviceNames) {
    const deps = config.services[name].dependsOn;
    for (const dep of deps) {
      if (!(dep in config.services)) {
        throw new DagError(`Service "${name}" depends on unknown service "${dep}"`);
      }
    }
  }

  // Detect cycles via DFS with gray/black colouring.
  // This runs before Kahn's algorithm to provide detailed error messages
  // that include the exact cycle path (e.g. "A → B → C → A").
  // Kahn's algorithm also detects cycles (via remaining node count) but
  // cannot reconstruct the path, so it only serves as a defensive fallback.
  detectCycles(config);

  // Topological sort via Kahn's algorithm into parallel layers

  // inDegree is the standard graph theory term for the number of incoming edges to a node.
  // In this case, it's the number of dependencies a service has.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const name of serviceNames) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const name of serviceNames) {
    const deps = config.services[name].dependsOn;
    inDegree.set(name, deps.length);
    for (const dep of deps) {
      dependents.get(dep)!.push(name);
    }
  }

  const layers: ExecutionLayer[] = [];
  let remaining = serviceNames.length;

  // First layer: services with no dependencies
  let currentLayer = serviceNames.filter((name) => inDegree.get(name) === 0).sort();

  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    remaining -= currentLayer.length;

    const nextLayer: string[] = [];
    for (const name of currentLayer) {
      for (const dependent of dependents.get(name)!) {
        const newDegree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextLayer.push(dependent);
        }
      }
    }
    currentLayer = nextLayer.sort();
  }

  if (remaining > 0) {
    throw new DagError("Cycle detected in service dependencies");
  }

  return { layers, serviceCount: serviceNames.length };
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

function detectCycles(config: WorkspaceConfig): void {
  const serviceNames = Object.keys(config.services);
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const name of serviceNames) {
    color.set(name, WHITE);
  }

  for (const name of serviceNames) {
    if (color.get(name) === WHITE) {
      dfs(name, config, color, parent);
    }
  }
}

function dfs(
  node: string,
  config: WorkspaceConfig,
  color: Map<string, number>,
  parent: Map<string, string | null>,
): void {
  color.set(node, GRAY);

  for (const dep of config.services[node].dependsOn) {
    if (color.get(dep) === GRAY) {
      // Found a cycle — reconstruct the path
      const cycle = [dep, node];
      let current: string | null | undefined = parent.get(node);
      while (current && current !== dep) {
        cycle.push(current);
        current = parent.get(current);
      }
      cycle.reverse();
      throw new DagError(`Dependency cycle detected: ${cycle.join(" → ")} → ${dep}`);
    }

    if (color.get(dep) === WHITE) {
      parent.set(dep, node);
      dfs(dep, config, color, parent);
    }
  }

  color.set(node, BLACK);
}
