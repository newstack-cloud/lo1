import { z } from "zod";
import { serviceHooksSchema } from "./hooks";

export const serviceProxySchema = z.object({
  domain: z.string().optional(),
  pathPrefix: z.string().optional(),
});

export type ServiceProxy = z.infer<typeof serviceProxySchema>;

export const serviceConfigSchema = z.object({
  type: z.string(),
  path: z.string(),
  port: z.number().optional(),
  hostPort: z.number().optional(),
  mode: z.enum(["dev", "container", "skip"]).default("dev"),
  command: z.string().optional(),
  containerImage: z.string().optional(),
  plugin: z.record(z.string(), z.unknown()).optional(),
  compose: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  proxy: serviceProxySchema.optional(),
  hooks: serviceHooksSchema.optional(),
  dependsOn: z.array(z.string()).default([]),
  initTask: z.boolean().default(false),
  readinessProbe: z.string().url().optional(),
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
