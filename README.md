# lo1

[![CI](https://github.com/two-six-tech/lo1/actions/workflows/ci.yml/badge.svg)](https://github.com/two-six-tech/lo1/actions/workflows/ci.yml)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=newstack-cloud_lo1&metric=coverage)](https://sonarcloud.io/summary/new_code?id=newstack-cloud_lo1)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=newstack-cloud_lo1&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=newstack-cloud_lo1)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=newstack-cloud_lo1&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=newstack-cloud_lo1)

Multi-service local development environment. Orchestrate services, infrastructure, and reverse proxying with a single `lo1 up`.

> `lo` = loopback interface, `1` from `::1` (IPv6 loopback)

## Packages

| Package | Description |
|---|---|
| [`@lo1/cli`](./packages/cli) | CLI application — `lo1 init`, `lo1 up`, `lo1 down`, `lo1 status` |
| [`@lo1/sdk`](./packages/sdk) | Plugin SDK — types, config schemas, and utilities for plugin authors |
| [`@lo1/plugin-celerity`](./plugins/celerity) | Celerity plugin — blueprint-driven compose, provisioning, and seeding |

## Quick Start

```bash
# Install globally
bun install -g @lo1/cli

# Initialize a workspace (clones repositories, sets up infrastructure)
lo1 init

# Start all services
lo1 up

# Check service status
lo1 status

# Stop everything
lo1 down
```

## Configuration

Define your workspace in `lo1.yaml`:

```yaml
version: "1"
name: my-project

services:
  api:
    type: process
    path: ./services/api
    port: 3000
    command: bun run dev

  frontend:
    type: frontend
    path: ./services/web
    port: 5173
    command: bun run dev

proxy:
  tld: local
  tls:
    enabled: true
```

The `@lo1/sdk` package publishes a [JSON Schema](./packages/sdk/schemas/lo1.v1.schema.json) for IDE autocompletion and validation.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, commands, and commit conventions.

## License

[Apache-2.0](./LICENSE)
