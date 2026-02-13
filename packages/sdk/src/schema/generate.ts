import { zodToJsonSchema } from "zod-to-json-schema";
import { workspaceSchema } from "../config/workspace";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const jsonSchema = zodToJsonSchema(workspaceSchema, {
  name: "lo1.v1",
  $refStrategy: "none",
});

const output = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://lo1.dev/schemas/lo1.v1.schema.json",
  ...jsonSchema,
};

const outPath = resolve(import.meta.dir, "../../schemas/lo1.v1.schema.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Generated ${outPath}`);
