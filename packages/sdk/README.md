# @lo1/sdk

Plugin SDK for [lo1](../../README.md) — types, configuration schemas, and utilities for plugin authors.

## Installation

```bash
bun add @lo1/sdk
```

## Usage

### Plugin authoring

```typescript
import type { PluginFactory } from "@lo1/sdk";

const createPlugin: PluginFactory = (context) => {
  return {
    name: "my-plugin",

    async contributeCompose(input) {
      // Return Docker Compose service definitions for shared infrastructure
    },

    async provisionInfra(input) {
      // Create infrastructure resources (tables, buckets, schemas)
    },

    async seedData(input) {
      // Apply seed data to provisioned infrastructure
    },
  };
};

export default createPlugin;
```

### Configuration validation

```typescript
import { workspaceSchema } from "@lo1/sdk";

const result = workspaceSchema.safeParse(rawConfig);
if (!result.success) {
  console.error(result.error.issues);
}
```

### JSON Schema

A generated JSON Schema is available for IDE autocompletion:

```json
{
  "$schema": "https://lo1.dev/schemas/lo1.v1.schema.json"
}
```

Or reference the published schema file:

```typescript
import "@lo1/sdk/schemas/lo1.v1.schema.json";
```

## Exports

- **Plugin types** — `Plugin`, `PluginFactory`, `PluginContext`, `Logger`
- **Lifecycle types** — `ComposeInput`, `ComposeContribution`, `ProvisionInput`, `ProvisionResult`, `SeedInput`, `SeedResult`, `ContainerInput`, `ContainerConfig`, `WatchInput`, `RestartSignal`
- **Config schemas** (Zod) — `workspaceSchema`, `serviceConfigSchema`, `proxyConfigSchema`, `tlsConfigSchema`, `serviceHooksSchema`, `workspaceHooksSchema`
- **Config types** — `WorkspaceConfig`, `ServiceConfig`, `ProxyConfig`, `TlsConfig`, `ServiceHooks`, `WorkspaceHooks`
