# @lo1/plugin-celerity

[Celerity](https://celerityframework.io) plugin for [lo1](../../README.md) — blueprint-driven compose generation, infrastructure provisioning, data seeding, and runtime configuration.

## Installation

```bash
bun add @lo1/plugin-celerity
```

## Configuration

Register the plugin in your `lo1.yaml`:

```yaml
version: "1"
name: my-project

plugins:
  celerity: "@lo1/plugin-celerity"

services:
  api:
    type: celerity
    path: ./services/api
    port: 8080
```

## Plugin Lifecycle

| Method | Description |
|---|---|
| `contributeCompose` | Reads Celerity blueprints and generates Docker Compose service definitions for local infrastructure (queues, topics, datastores) |
| `provisionInfra` | Creates infrastructure resources (tables, buckets, schemas) after the compose stack is healthy |
| `seedData` | Applies seed data to provisioned infrastructure |
| `configureContainer` | Returns container configuration for running a Celerity service in container mode |
| `watchForChanges` | Watches blueprint and source files for changes, yielding restart signals |

## Status

This plugin is a placeholder for future implementation. The lifecycle methods will be implemented as part of the lo1 L8 milestone.
