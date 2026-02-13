import { z } from "zod";

export const serviceHooksSchema = z.object({
  preStart: z.string().optional(),
  postStart: z.string().optional(),
  preStop: z.string().optional(),
});

export type ServiceHooks = z.infer<typeof serviceHooksSchema>;

export const workspaceHooksSchema = z.object({
  postInfrastructure: z.string().optional(),
  postSetup: z.string().optional(),
  preStop: z.string().optional(),
});

export type WorkspaceHooks = z.infer<typeof workspaceHooksSchema>;
