import { describe, it, expect } from "bun:test";
import { buildDag, DagError } from "../../src/dag/index";
import type { WorkspaceConfig } from "@lo1/sdk";

function makeConfig(
  services: Record<string, { dependsOn?: string[] }>,
): WorkspaceConfig {
  const svcEntries = Object.fromEntries(
    Object.entries(services).map(([name, { dependsOn }]) => [
      name,
      { type: "service", path: `./${name}`, dependsOn: dependsOn ?? [] },
    ]),
  );

  return {
    version: "1",
    name: "test",
    services: svcEntries,
  } as WorkspaceConfig;
}

describe("buildDag", () => {
  it("should handle a single service with no dependencies", () => {
    // Arrange
    const config = makeConfig({ api: {} });

    // Act
    const result = buildDag(config);

    // Assert
    expect(result.layers).toEqual([["api"]]);
    expect(result.serviceCount).toBe(1);
  });

  it("should place independent services in the same layer", () => {
    // Arrange
    const config = makeConfig({
      api: {},
      web: {},
      worker: {},
    });

    // Act
    const result = buildDag(config);

    // Assert
    expect(result.layers).toEqual([["api", "web", "worker"]]);
    expect(result.serviceCount).toBe(3);
  });

  it("should produce layers for a linear dependency chain", () => {
    // Arrange
    const config = makeConfig({
      app: { dependsOn: ["api"] },
      api: { dependsOn: ["db"] },
      db: {},
    });

    // Act
    const result = buildDag(config);

    // Assert
    expect(result.layers).toEqual([["db"], ["api"], ["app"]]);
  });

  it("should handle diamond dependencies", () => {
    // Arrange — db → (api, worker) → app
    const config = makeConfig({
      app: { dependsOn: ["api", "worker"] },
      api: { dependsOn: ["db"] },
      worker: { dependsOn: ["db"] },
      db: {},
    });

    // Act
    const result = buildDag(config);

    // Assert
    expect(result.layers).toEqual([["db"], ["api", "worker"], ["app"]]);
  });

  it("should handle complex multi-layer dependencies", () => {
    // Arrange
    const config = makeConfig({
      frontend: { dependsOn: ["api"] },
      api: { dependsOn: ["db", "cache"] },
      worker: { dependsOn: ["db", "queue"] },
      db: {},
      cache: {},
      queue: {},
    });

    // Act
    const result = buildDag(config);

    // Assert
    expect(result.layers[0]).toEqual(["cache", "db", "queue"]);
    expect(result.layers[1]).toEqual(["api", "worker"]);
    expect(result.layers[2]).toEqual(["frontend"]);
    expect(result.serviceCount).toBe(6);
  });

  it("should throw DagError for unknown dependency reference", () => {
    // Arrange
    const config = makeConfig({
      api: { dependsOn: ["nonexistent"] },
    });

    // Act & Assert
    expect(() => buildDag(config)).toThrow(DagError);
    expect(() => buildDag(config)).toThrow('depends on unknown service "nonexistent"');
  });

  it("should throw DagError for self-referencing dependency", () => {
    // Arrange
    const config = makeConfig({
      api: { dependsOn: ["api"] },
    });

    // Act & Assert
    expect(() => buildDag(config)).toThrow(DagError);
    expect(() => buildDag(config)).toThrow("cycle");
  });

  it("should throw DagError for a simple cycle", () => {
    // Arrange — a → b → a
    const config = makeConfig({
      a: { dependsOn: ["b"] },
      b: { dependsOn: ["a"] },
    });

    // Act & Assert
    expect(() => buildDag(config)).toThrow(DagError);
    expect(() => buildDag(config)).toThrow("cycle");
  });

  it("should throw DagError for a complex cycle", () => {
    // Arrange — a → b → c → a, with d independent
    const config = makeConfig({
      a: { dependsOn: ["b"] },
      b: { dependsOn: ["c"] },
      c: { dependsOn: ["a"] },
      d: {},
    });

    // Act & Assert
    expect(() => buildDag(config)).toThrow(DagError);
    expect(() => buildDag(config)).toThrow("cycle");
  });
});
