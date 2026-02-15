import { describe, it, expect } from "bun:test";
import { resolveServiceFilter, FilterError } from "../../src/orchestrator/filter";
import type { WorkspaceConfig } from "@lo1/sdk";

function makeConfig(services: Record<string, { dependsOn: string[] }>): WorkspaceConfig {
  const svcEntries: Record<string, WorkspaceConfig["services"][string]> = {};
  for (const [name, { dependsOn }] of Object.entries(services)) {
    svcEntries[name] = {
      type: "service",
      path: `./${name}`,
      mode: "dev",
      dependsOn,
    };
  }
  return { version: "1", name: "test", services: svcEntries };
}

describe("resolveServiceFilter", () => {
  it("should return just the requested service when it has no deps", () => {
    const config = makeConfig({
      api: { dependsOn: [] },
      web: { dependsOn: [] },
    });

    const result = resolveServiceFilter(["api"], config);

    expect(result).toEqual(new Set(["api"]));
  });

  it("should include transitive dependencies", () => {
    const config = makeConfig({
      api: { dependsOn: ["db"] },
      db: { dependsOn: ["cache"] },
      cache: { dependsOn: [] },
      web: { dependsOn: [] },
    });

    const result = resolveServiceFilter(["api"], config);

    expect(result).toEqual(new Set(["api", "db", "cache"]));
  });

  it("should handle diamond dependencies without duplicates", () => {
    const config = makeConfig({
      api: { dependsOn: ["auth", "db"] },
      auth: { dependsOn: ["db"] },
      db: { dependsOn: [] },
    });

    const result = resolveServiceFilter(["api"], config);

    expect(result).toEqual(new Set(["api", "auth", "db"]));
  });

  it("should throw FilterError on unknown service name", () => {
    const config = makeConfig({
      api: { dependsOn: [] },
    });

    expect(() => resolveServiceFilter(["nope"], config)).toThrow(FilterError);
    expect(() => resolveServiceFilter(["nope"], config)).toThrow(
      'Unknown service "nope"',
    );
  });

  it("should return all services when filter matches all", () => {
    const config = makeConfig({
      a: { dependsOn: ["b"] },
      b: { dependsOn: ["c"] },
      c: { dependsOn: [] },
    });

    const result = resolveServiceFilter(["a", "b", "c"], config);

    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("should handle multiple requested services merging deps", () => {
    const config = makeConfig({
      api: { dependsOn: ["db"] },
      web: { dependsOn: ["cache"] },
      db: { dependsOn: [] },
      cache: { dependsOn: [] },
    });

    const result = resolveServiceFilter(["api", "web"], config);

    expect(result).toEqual(new Set(["api", "web", "db", "cache"]));
  });
});
