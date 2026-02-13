import { z } from "zod";

export const tlsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().default(443),
  certDir: z.string().default(".lo1/certs"),
});

export type TlsConfig = z.infer<typeof tlsConfigSchema>;

export const proxyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(80),
  tld: z.string().default("local"),
  tls: tlsConfigSchema.optional(),
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;
