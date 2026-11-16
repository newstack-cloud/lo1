import { z } from "zod";
import { workspaceSchema } from "../config/workspace";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// `input` describes lo1.yaml as written, so fields with defaults stay optional.
// Input mode leaves objects open; closing them lets editors flag unknown keys.
const jsonSchema = z.toJSONSchema(workspaceSchema, {
  target: "draft-7",
  io: "input",
  override: ({ jsonSchema: node }) => {
    if (node.type === "object" && node.properties && node.additionalProperties === undefined) {
      node.additionalProperties = false;
    }
  },
});

const output = {
  ...jsonSchema,
  $id: "https://lo1.dev/schemas/lo1.v1.schema.json",
};

const outPath = resolve(import.meta.dir, "../../schemas/lo1.v1.schema.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Generated ${outPath}`);
