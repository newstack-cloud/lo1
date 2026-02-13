# @lo1/cli

CLI for [lo1](../../README.md) — multi-service local development environment.

## Installation

```bash
bun install -g @lo1/cli    # Bun
npm install -g @lo1/cli    # npm
yarn global add @lo1/cli   # Yarn
pnpm add -g @lo1/cli       # pnpm
```

## Commands

| Command | Description |
|---|---|
| `lo1 init` | Initialize workspace — clone repositories defined in `lo1.yaml` |
| `lo1 up` | Start all services and infrastructure |
| `lo1 down` | Stop all services and infrastructure |
| `lo1 status` | Show status of all services |
| `lo1 hosts` | Manage `/etc/hosts` entries for local domains |
| `lo1 tls-setup` | Generate locally-trusted TLS certificates via mkcert |

## Usage

```bash
# Initialize workspace (clone repos, set up infra)
lo1 init

# Start everything
lo1 up

# Start specific services
lo1 up api frontend

# Check status
lo1 status

# Stop everything
lo1 down
```

## Configuration

The CLI reads `lo1.yaml` from the current directory. See the [@lo1/sdk README](../sdk/README.md) for schema details.
