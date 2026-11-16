import { describe, it, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspaceConfig } from "../../src/config/loader";
import { buildDag } from "../../src/dag/index";

const examplesDir = join(import.meta.dir, "..", "..", "..", "..", "examples");
const examples = readdirSync(examplesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("examples", () => {
  it("should include at least one example", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  for (const example of examples) {
    it(`should have a valid lo1.yaml with no dependency cycles: ${example}`, async () => {
      const config = await loadWorkspaceConfig(join(examplesDir, example, "lo1.yaml"));

      expect(() => buildDag(config)).not.toThrow();
    });
  }
});
