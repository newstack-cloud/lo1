import { z } from "zod";
import { serviceConfigSchema } from "./service";
import { proxyConfigSchema } from "./proxy";
import { workspaceHooksSchema } from "./hooks";

export const repositorySchema = z.object({
  url: z.string(),
  path: z.string(),
  branch: z.string().optional(),
});

export type Repository = z.infer<typeof repositorySchema>;

export const workspaceSchema = z.object({
  version: z.literal("1"),
  name: z.string(),
  plugins: z.record(z.string(), z.string()).optional(),
  repositories: z.record(z.string(), repositorySchema).optional(),
  proxy: proxyConfigSchema.optional(),
  services: z.record(z.string(), serviceConfigSchema),
  extraCompose: z
    .union([
      z.string(),
      z.object({
        file: z.string(),
        initTaskServices: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
  hooks: workspaceHooksSchema.optional(),
});

export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
