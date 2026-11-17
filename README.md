![lo1](/resources/logo.svg)

Your whole system, running locally

- [Contributing](./CONTRIBUTING.md)
- [Docs Site](https://lo1.dev)

[![CI](https://github.com/newstack-cloud/lo1/actions/workflows/ci.yml/badge.svg)](https://github.com/newstack-cloud/lo1/actions/workflows/ci.yml)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=newstack-cloud_lo1&metric=coverage)](https://sonarcloud.io/summary/new_code?id=newstack-cloud_lo1)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=newstack-cloud_lo1&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=newstack-cloud_lo1)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=newstack-cloud_lo1&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=newstack-cloud_lo1)
[![NPM Version](https://img.shields.io/npm/v/%40lo1%2Fcli)](https://www.npmjs.com/package/@lo1/cli)

Multi-service local development environment. Orchestrate services, infrastructure, and reverse proxying with a single `lo1 up`.

> `lo` = loopback interface, `1` from `::1` (IPv6 loopback)

## Packages

| Package                                      | Description                                                           |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [`@lo1/cli`](./packages/cli)                 | CLI application — `lo1 init`, `lo1 up`, `lo1 down`, `lo1 status`      |
| [`@lo1/sdk`](./packages/sdk)                 | Plugin SDK — types, config schemas, and utilities for plugin authors  |
| [`@lo1/plugin-celerity`](./plugins/celerity) | Celerity plugin — blueprint-driven compose, provisioning, and seeding |

## Prerequisites

| Dependency                                    | Version | Purpose                                           |
| --------------------------------------------- | ------- | ------------------------------------------------- |
| [Node.js](https://nodejs.org/)                | 24+     | CLI runtime                                       |
| [Docker](https://docs.docker.com/get-docker/) | 20.10+  | Container services, infrastructure, reverse proxy |
| [Git](https://git-scm.com/)                   | 2.x     | Repository cloning (`lo1 init`)                   |

Docker Compose v2 is included with Docker Desktop (macOS/Windows) and modern Docker Engine (Linux).

## Quick Start

lo1 runs on Node.js 24 or later. You can install it with npm, pnpm, Yarn or Bun, but Node.js is still needed: the `lo1` command runs on Node whichever package manager installed it.

```bash
# Install globally (pick your package manager)
npm install -g @lo1/cli    # npm
pnpm add -g @lo1/cli       # pnpm
yarn global add @lo1/cli   # Yarn
bun install -g @lo1/cli    # Bun

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
    type: service
    path: ./services/api
    port: 3000
    command: bun run dev

  frontend:
    type: app
    path: ./services/web
    port: 5173
    command: bun run dev

proxy:
  tld: local
  tls:
    enabled: true
```

The `@lo1/sdk` package publishes a [JSON Schema](./packages/sdk/schemas/lo1.v1.schema.json) for IDE autocompletion and validation.

## TLS

`proxy.tls.mode` picks how the proxy gets its certificates.

### `internal` (default)

Caddy's built-in CA issues the certificates, and `lo1 up` installs the root into
the host trust store. Only the machine running lo1 trusts them, so other devices
on the LAN will see certificate warnings.

### `acme`

Caddy obtains and renews publicly trusted certificates itself over the DNS-01
challenge, so every device on the network accepts them with nothing to install.
Because the stock Caddy image cannot solve DNS challenges, lo1 rebuilds the
proxy image with the matching [`caddy-dns`](https://github.com/caddy-dns)
provider module.

```yaml
proxy:
  tld: dev # a real domain you control, e.g. my-project.dev
  tls:
    enabled: true
    mode: acme
    acme:
      provider: cloudflare # any caddy-dns provider name
      tokenEnv: CF_API_TOKEN # host env var holding the DNS API credential
      email: me@example.com # ACME account email
      domains: ["*.my-project.dev"] # names ACME should cover
      ca: letsencrypt # or "staging" while you are testing
      resolvers: ["1.1.1.1"]
      propagationTimeout: 5m
```

The credential is passed to the container by name (`${CF_API_TOKEN}`), so the
secret never lands in a generated file. Export it in the shell you run `lo1 up`
from. A `.env` file is not enough on its own, because lo1 checks the process
environment and fails before Docker Compose would interpolate one.

`domains` declares which names ACME issues for. Hosts covered by a wildcard are
folded into a single site block, so Caddy orders one certificate for the whole
set rather than one per service, and adding a service needs no new issuance.

Anything that does not match `domains` falls back to the internal CA, which is
what lets a workspace mix the two. A service given
`proxy.domain: api.local.example.com` gets a publicly trusted certificate, while
the default `api.<workspace>.local` host keeps using Caddy's local CA, since no
public CA can issue for a `.local` name. Leaving `domains` empty lets ACME cover
every site, which only works if every host is a public name.

Renewal is entirely Caddy's job. It renews in the background and reloads itself,
so there is no external ACME client to run and no reload hook to wire up.

Other providers work the same way. Set `provider` to `route53`, `digitalocean`,
`azure`, or any other name matching a module in the
[`caddy-dns`](https://github.com/caddy-dns) org. Providers needing more than a
single credential take extra environment variables through `env: [...]` and
nested directive options through `options: {...}`. Use `module` to override the
Go module path when you need a specific version.

**Reaching the domains from other devices.** Real certificates are only half of
what is needed, because the other devices also have to resolve those names to
this machine. Point A records for the domain, or for the wildcard, at this
machine's LAN IP in the DNS zone you already control, or add the hosts to your
router's DNS. lo1's `/etc/hosts` management only covers the machine running it.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, commands, and commit conventions.

## License

[Apache-2.0](./LICENSE)
