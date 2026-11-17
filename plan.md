# lo1 — Multi-Service Local Dev Environment

## Context

Developers building real systems have multiple frontends + backends that communicate synchronously and asynchronously. Being able to spin up an entire system or subsystem locally — with shared infrastructure — dramatically improves productivity by revealing integration issues without deploying.

Rather than embedding this into the Celerity CLI, this is a **standalone tool** called **lo1** (`lo` = loopback interface + `1` from `::1`, the IPv6 loopback address) with a **plugin system** where Celerity is a first-class plugin. This gives it broader utility — any team can use it, whether or not they use Celerity. Domain: `lo1.dev`.

### Positioning

lo1 is a small, lean orchestration core that scales through plugins. The core handles config, dependency ordering, compose management, process/container runners, proxy, and headless CLI output with per-service log files. Everything service-type-specific (Celerity, custom frameworks, etc.) lives in plugins loaded at runtime.

Not promoting until around/after Celerity + Bluelink v1 — lo1 unlocks the multi-service async local dev story for Celerity. A docs site with parity to bluelink.dev / celerityframework.io is a future milestone.

### Key Decisions

- **TypeScript + Bun** — dynamic plugin loading, fast startup, single-binary distribution via `bun build --compile`
- **Runtime plugin system** — plugins are npm packages or local directories, loaded via dynamic `import()`
- **Convention-based async wiring** — services sharing queues/topics use matching `spec.name` values
- **Caddy reverse proxy** with configurable TLD + local TLS via `tls internal` + `caddy trust`
- **Service-level compose overrides** layered via Docker Compose `-f` flags
- **Service-level lifecycle hooks** (preStart, postStart, preStop)
- **Multi-repo workspace bootstrap** via `repositories` section + `lo1 init`

---

## 1. Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | Bun (fast startup, native TS, `bun build --compile` for distribution) |
| Monorepo | Bun workspaces (`workspaces` in root `package.json`) |
| CLI framework | Commander.js |
| Config parsing | js-yaml |
| Config validation | Zod |
| Docker interaction | Shell out to `docker compose` CLI (compose management), `docker run`/`docker stop`/`docker rm` for container runner |
| File watching | chokidar |
| Testing | `bun test` (built-in, Vitest-compatible API) |
| Linting | ESLint 9 (flat config) + Prettier |
| Commits | Conventional commits via commitlint + `.githooks/` |
| Releases | release-please (automated release PRs, changelogs, npm publish) |
| Config schema | Zod (canonical definition) + `zod-to-json-schema` (generated JSON Schema for IDE support) |
| Schema validation | AJV (Draft 2020-12, test-time validation of generated schema) |
| Debug logging | `debug` package — `DEBUG=lo1:*` scoped diagnostic output, zero overhead when disabled |
| Plugin SDK | `@lo1/sdk` package — plugin types, config Zod schemas, generated JSON Schema |

---

## 2. Project Structure

```
lo1/
  packages/
    cli/                            -- the CLI (npm: @lo1/cli, binary: lo1)
      src/
        cli/
          commands/
            init.ts
            up.ts
            down.ts
            status.ts
            hosts.ts
            tls-setup.ts
            logs.ts
          index.ts                  -- Commander program setup
        config/                     -- Workspace manifest types, loader, Zod schemas
        dag/                        -- Dependency DAG, topological sort, cycle detection
        compose/                    -- Unified compose generation + docker compose CLI wrapper
        runner/                     -- ServiceRunner interface + ProcessRunner, ContainerRunner
        discovery/                  -- Service registry, env var generation
        proxy/                      -- Caddyfile generation, /etc/hosts, TLS setup
        hooks/                      -- Hook execution (subprocess, streaming, env injection)
        repos/                      -- Multi-repo clone/init
        orchestrator/               -- Startup/shutdown state machine
        plugin/                     -- Plugin loader, registry, core type handlers
        logs/                       -- Per-service log file writer (.lo1/logs/)
      package.json                  -- name: "@lo1/cli", bin: { "lo1": "./dist/lo1.js" }
    sdk/                            -- Plugin SDK (npm: @lo1/sdk)
      src/
        index.ts                    -- Plugin interface, input/output types, re-exports
        config/                     -- Zod schemas for lo1.yaml (canonical config definition)
          workspace.ts              -- Top-level workspace schema
          service.ts                -- Service config schema (service, app, plugin types)
          proxy.ts                  -- Proxy config schema
          hooks.ts                  -- Hook config schema
          index.ts                  -- Composed schema + inferred TS types
        schema/
          generate.ts               -- Build script: Zod → JSON Schema via zod-to-json-schema
      schemas/
        lo1.v1.schema.json          -- Generated JSON Schema (Draft 2020-12) for lo1.yaml
      package.json                  -- name: "@lo1/sdk"
  plugins/
    celerity/                       -- Celerity plugin (npm: @lo1/plugin-celerity)
      src/
        index.ts                    -- Plugin factory
        compose.ts                  -- Blueprint → compose contribution
        provision.ts                -- Table/bucket creation
        seed.ts                     -- Seed data application
        container.ts                -- Runtime container config
        watch.ts                    -- File watcher for handler changes
      package.json                  -- name: "@lo1/plugin-celerity"

  # Monorepo root
  package.json                      -- Bun workspace root, devDependencies for tooling
  bun.lock
  tsconfig.base.json                -- Shared TS config (strict, ES2023, ESNext modules)
  tsconfig.json                     -- Root type-check config (noEmit, includes all packages)
  eslint.config.mjs                 -- ESLint 9 flat config
  prettier.config.mjs               -- Prettier config
  commitlint.config.js              -- Conventional commit rules (types + scopes)
  release-please-config.json        -- Component release definitions
  .release-please-manifest.json     -- Current package versions
  sonar-project.properties          -- SonarCloud config
  .githooks/
    commit-msg                      -- commitlint enforcement
    pre-commit                      -- lint + format check on changed packages
  .github/
    workflows/
      ci.yml                        -- Format, audit, lint, typecheck, build, test + SonarCloud
      release-please.yml            -- Automated release PRs + npm publish
      codeql.yml                    -- CodeQL security scanning (JS/TS)
      security.yml                  -- Actionlint for workflow validation
    dependabot.yml                  -- Dependency update automation (per-package)
    PULL_REQUEST_TEMPLATE.md
  CONTRIBUTING.md
  COMMIT_GUIDELINES.md
```

---

## 3. Monorepo Tooling

### Bun Workspaces

Root `package.json`:

```json
{
  "name": "lo1",
  "private": true,
  "workspaces": ["packages/*", "plugins/*"],
  "devDependencies": {
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0",
    "eslint": "^9.0.0",
    "@eslint/js": "^9.0.0",
    "typescript-eslint": "^8.0.0",
    "eslint-config-prettier": "^9.0.0",
    "prettier": "^3.2.0",
    "typescript": "^5.7.0"
  },
  "scripts": {
    "build": "bun run --filter '*' build",
    "test": "bun run --filter '*' test",
    "test:coverage": "bun test --coverage --coverage-reporter=lcov && bun run scripts/check-coverage.ts",
    "lint": "eslint packages/ plugins/",
    "lint:fix": "eslint packages/ plugins/ --fix",
    "lint:report": "eslint packages/ plugins/ -f json -o eslint-report.json || true",
    "format": "prettier --write \"packages/*/src/**/*.ts\" \"plugins/*/src/**/*.ts\"",
    "format:check": "prettier --check \"packages/*/src/**/*.ts\" \"plugins/*/src/**/*.ts\"",
    "typecheck": "bun run --filter '*' typecheck",
    "clean": "bun run --filter '*' clean"
  }
}
```

### Conventional Commits

`commitlint.config.js` — matches pattern from Celerity, Celerity Node SDK, and Bluelink:

```javascript
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", [
      "fix", "build", "revert", "wip", "feat", "chore", "ci",
      "docs", "style", "refactor", "perf", "test", "instr", "deps"
    ]],
    "scope-enum": [2, "always", [
      "cli", "sdk", "plugin-celerity", "ci", "repo", "deps"
    ]]
  }
};
```

### Git Hooks

`.githooks/commit-msg`:
```bash
#!/bin/sh
bunx commitlint --edit $1
```

`.githooks/pre-commit`:
```bash
#!/bin/sh
# Only lint if package source changed
CHANGED=$(git diff HEAD --name-only --cached | grep "^packages/\|^plugins/")
if [ -n "$CHANGED" ]; then
  bun run lint && bun run format:check
fi
```

Setup: `git config core.hooksPath .githooks`

### Release-Please

`release-please-config.json`:

```json
{
  "include-component-in-tag": true,
  "tag-separator": "/",
  "separate-pull-requests": true,
  "bump-minor-pre-major": true,
  "prerelease-type": "alpha",
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance Improvements" },
    { "type": "deps", "section": "Dependencies" },
    { "type": "chore", "section": "Miscellaneous", "hidden": true }
  ],
  "pull-request-title-pattern": "chore: release ${component} ${version}",
  "plugins": [
    { "type": "linked-versions", "groupName": "lo1", "components": ["cli", "sdk", "plugin-celerity"] }
  ],
  "packages": {
    "packages/cli": { "component": "cli", "release-type": "node" },
    "packages/sdk": { "component": "sdk", "release-type": "node" },
    "plugins/celerity": { "component": "plugin-celerity", "release-type": "node" }
  }
}
```

`.release-please-manifest.json`:
```json
{
  "packages/cli": "0.0.0",
  "packages/sdk": "0.0.0",
  "plugins/celerity": "0.0.0"
}
```

### CI Workflow

`.github/workflows/ci.yml` — triggered on PR to main + push to main:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile

      - run: bun run format:check

      - run: bun audit --audit-level high

      - run: bun run lint

      - name: Generate ESLint report for SonarCloud
        run: bun run lint:report

      - run: bun run build

      - run: bun run typecheck

      - name: Run all tests with coverage
        run: bun test --coverage --coverage-reporter=lcov

      - name: SonarCloud Scan
        uses: SonarSource/sonarqube-scan-action@v7
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

`.github/workflows/release-please.yml` — triggered on push to main:
1. `googleapis/release-please-action@v4` creates/updates release PRs
2. On release created: `bun publish --access public` for each released package

### Security Scanning

`.github/workflows/codeql.yml` — CodeQL analysis:
- **Triggers:** push to main, PRs, weekly schedule (Monday 04:00 UTC)
- **Language:** `javascript-typescript`
- **Query suite:** `+security-extended`

`.github/workflows/security.yml` — Actionlint:
- **Triggers:** PRs only
- Validates GitHub Actions workflow files
- Posts inline review comments on issues

### Dependabot

`.github/dependabot.yml` — per-package dependency update automation:

```yaml
version: 2
updates:
  # GitHub Actions
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "04:00"
    commit-message:
      prefix: "ci(deps)"
    groups:
      actions:
        patterns: ["*"]
        update-types: ["minor", "patch"]

  # Root dependencies (tooling)
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "04:30"
    commit-message:
      prefix: "deps"
    groups:
      root-deps:
        patterns: ["*"]
        update-types: ["minor", "patch"]
    ignore:
      - dependency-name: "@lo1/*"

  # packages/cli
  - package-ecosystem: npm
    directory: /packages/cli
    schedule:
      interval: weekly
      day: monday
      time: "04:30"
    commit-message:
      prefix: "deps(cli)"
    groups:
      cli-deps:
        patterns: ["*"]
        update-types: ["minor", "patch"]
    ignore:
      - dependency-name: "@lo1/*"

  # packages/sdk
  - package-ecosystem: npm
    directory: /packages/sdk
    schedule:
      interval: weekly
      day: monday
      time: "04:30"
    commit-message:
      prefix: "deps(sdk)"
    groups:
      sdk-deps:
        patterns: ["*"]
        update-types: ["minor", "patch"]
    ignore:
      - dependency-name: "@lo1/*"

  # plugins/celerity
  - package-ecosystem: npm
    directory: /plugins/celerity
    schedule:
      interval: weekly
      day: monday
      time: "04:30"
    commit-message:
      prefix: "deps(plugin-celerity)"
    groups:
      plugin-celerity-deps:
        patterns: ["*"]
        update-types: ["minor", "patch"]
    ignore:
      - dependency-name: "@lo1/*"
```

### SonarCloud

`sonar-project.properties`:

```properties
sonar.projectKey=newstack-cloud_lo1
sonar.organization=newstack-cloud
sonar.projectName=lo1

# Source and test directories (glob-based, auto-covers new packages/plugins)
sonar.sources=packages,plugins
sonar.tests=packages,plugins
sonar.inclusions=packages/*/src/**,plugins/*/src/**
sonar.test.inclusions=packages/*/tests/**/*.test.ts,plugins/*/tests/**/*.test.ts

# Exclusions from analysis
sonar.exclusions=\
  **/node_modules/**,\
  **/dist/**,\
  **/*.js,\
  **/*.mjs,\
  **/*.cjs,\
  **/*.d.ts,\
  **/coverage/**

# Coverage (LCOV from bun test --coverage)
sonar.javascript.lcov.reportPaths=coverage/lcov.info

# ESLint report (JSON from eslint -f json)
sonar.eslint.reportPaths=eslint-report.json

sonar.sourceEncoding=UTF-8
```

### PR Template

`.github/PULL_REQUEST_TEMPLATE.md` — standardised PR description with:
- Summary of changes
- Related issues
- Testing checklist
- Breaking changes (if any)

---

## 4. Plugin System

### Plugin Interface

```typescript
// @lo1/sdk

export interface Plugin {
  /** Plugin identifier — matches service `type` in manifest. */
  name: string;

  /**
   * Inspects all services of this plugin's type and returns
   * compose service definitions for shared infrastructure.
   * Called once with ALL services of this type — the plugin deduplicates internally.
   */
  contributeCompose?(input: ComposeInput): Promise<ComposeContribution>;

  /**
   * Creates infrastructure resources (tables, buckets, schemas)
   * after the compose stack is healthy. Called once per service of this type.
   */
  provisionInfra?(input: ProvisionInput): Promise<ProvisionResult>;

  /**
   * Applies seed data to provisioned infrastructure.
   * Called once per service of this type, after provisionInfra.
   */
  seedData?(input: SeedInput): Promise<SeedResult>;

  /**
   * Returns the container configuration for running a service.
   * Only called for services in container/dev mode (not host process mode).
   */
  configureContainer?(input: ContainerInput): Promise<ContainerConfig>;

  /**
   * Sets up file watchers that trigger rebuilds/restarts.
   * Returns an async iterable that yields restart signals. Optional.
   */
  watchForChanges?(input: WatchInput): AsyncIterable<RestartSignal>;
}

export interface PluginContext {
  workspaceDir: string;
  workspaceName: string;
  logger: Logger;
}

/** Plugin module default export — factory that receives context and returns a Plugin. */
export type PluginFactory = (context: PluginContext) => Plugin | Promise<Plugin>;
```

### Input/Output Types

```typescript
// @lo1/sdk

export interface ComposeInput {
  services: Record<string, ServiceConfig>;  // all services of this plugin's type
  workspaceDir: string;
}

export interface ComposeContribution {
  services: Record<string, ComposeServiceDef>;  // compose services to add
  envVars: Record<string, string>;              // env vars for all services of this type
}

export interface ProvisionInput {
  serviceName: string;
  servicePath: string;
  endpoints: Record<string, string>;  // infrastructure endpoints from compose contribution
}

export interface ProvisionResult {
  created: string[];   // resources created
  skipped: string[];   // resources that already existed
}

export interface SeedInput {
  serviceName: string;
  servicePath: string;
  mode: "run" | "test";
  endpoints: Record<string, string>;
}

export interface SeedResult {
  applied: string[];
}

export interface ContainerInput {
  serviceName: string;
  servicePath: string;
  servicePort: string;
  mode: "dev" | "container";
  networkName: string;
  endpoints: Record<string, string>;
}

export interface ContainerConfig {
  image: string;
  cmd: string[];
  envVars: Record<string, string>;
  binds: string[];
  workingDir: string;
}

export interface WatchInput {
  serviceName: string;
  servicePath: string;
}

export interface RestartSignal {
  reason: string;
  changedFiles?: string[];
}
```

### Plugin Loading

```typescript
// packages/cli/src/plugin/loader.ts

/**
 * Plugins are declared in lo1.yaml and resolved as:
 * - npm package name: "@lo1/plugin-celerity" → import("@lo1/plugin-celerity")
 * - local path: "./plugins/custom" → import(resolve(workspaceDir, "./plugins/custom"))
 *
 * Each plugin module must default-export a PluginFactory.
 */
async function loadPlugin(specifier: string, context: PluginContext): Promise<Plugin> {
  const mod = await import(resolveSpecifier(specifier, context.workspaceDir));
  const factory: PluginFactory = mod.default;
  return factory(context);
}
```

### How It Works

1. Each service in the manifest has a `type` field (e.g. `celerity`, `service`, `app`)
2. `service` and `app` are handled by the **core** (built-in, not plugins) — `service` for backends/workers, `app` for frontends
3. Any other `type` is matched against declared plugins in the manifest
4. Plugins are loaded via dynamic `import()` at startup
5. The orchestrator calls plugin methods at the appropriate lifecycle stages
6. All plugin methods are optional — a plugin only implements what it needs

---

## 5. Configuration Schema

### Zod Schemas (Canonical Definition)

The Zod schemas in `@lo1/sdk` are the canonical definition of the `lo1.yaml` config shape. Both the CLI (for runtime validation) and the JSON Schema (for IDE support) derive from them.

```typescript
// @lo1/sdk — packages/sdk/src/config/workspace.ts

import { z } from "zod";
import { serviceConfigSchema } from "./service";
import { proxyConfigSchema } from "./proxy";
import { hooksConfigSchema } from "./hooks";

export const workspaceSchema = z.object({
  version: z.literal("1"),
  name: z.string(),
  plugins: z.record(z.string(), z.string()).optional(),
  repositories: z.record(z.string(), z.object({
    url: z.string(),
    path: z.string(),
    branch: z.string().optional(),
  })).optional(),
  proxy: proxyConfigSchema.optional(),
  services: z.record(z.string(), serviceConfigSchema),
  extraCompose: z.union([
    z.string(),
    z.object({
      file: z.string(),
      initTaskServices: z.array(z.string()).optional(),
    }),
  ]).optional(),
  hooks: hooksConfigSchema.optional(),
});

export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
```

### JSON Schema (Generated)

Generated at build time from Zod via `zod-to-json-schema`:

```
packages/sdk/schemas/lo1.v1.schema.json
```

- **Spec:** JSON Schema Draft 2020-12
- **`$id`:** `https://lo1.dev/schemas/lo1.v1.schema.json`
- **Generated by:** `packages/sdk/src/schema/generate.ts` (runs as part of `bun run build` in the SDK)
- **Published via:** subpath export in `@lo1/sdk`

```json
// packages/sdk/package.json (exports)
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./schemas/lo1.v1.schema.json": "./schemas/lo1.v1.schema.json"
  },
  "files": ["dist", "schemas"]
}
```

### IDE Integration

Users reference the schema in their `lo1.yaml` for autocompletion:

```yaml
# yaml-language-server: $schema=https://lo1.dev/schemas/lo1.v1.schema.json
version: "1"
name: my-platform
# ...
```

Or via local path when working with the lo1 source:

```yaml
# yaml-language-server: $schema=node_modules/@lo1/sdk/schemas/lo1.v1.schema.json
```

### Schema Validation Tests

AJV validates that the generated JSON schema stays in sync with the Zod schemas:

- Compile the JSON schema with AJV (Draft 2020-12)
- Run positive test cases (valid configs) and negative test cases (invalid configs, missing fields, bad types)
- Ensures schema generation doesn't drift from Zod definitions

---

## 6. Workspace Manifest — `lo1.yaml`

```yaml
version: "1"
name: my-platform

# Plugin declarations — maps type names to package specifiers
plugins:
  celerity: "@lo1/plugin-celerity"    # npm package
  # custom: "./plugins/custom"        # local path

# Optional: repositories to clone for multi-repo workspaces
repositories:
  users-api:
    url: git@github.com:acme/users-api.git
    path: ./services/users-api
    branch: main
  orders-api:
    url: git@github.com:acme/orders-api.git
    path: ./services/orders-api
  web-app:
    url: git@github.com:acme/web-app.git
    path: ./apps/web

# Reverse proxy config
proxy:
  enabled: true
  port: 80
  tld: local                    # services become *.my-platform.local
  tls:
    enabled: true
    port: 443
    certDir: .lo1/certs

services:
  # Celerity app — uses the celerity plugin
  users-api:
    type: celerity
    path: ./services/users-api
    port: 8080
    mode: dev                         # dev | container | skip
    plugin:                           # plugin-specific config (passed opaquely to plugin)
      deployTarget: aws
      runtime: nodejs22.x             # runtime resolved from blueprint (nodejs, python, dotnet, java, go)
    compose: .celerity/compose.yaml   # optional service-level compose override
    hooks:
      preStart: scripts/migrate.sh
    dependsOn: []

  orders-api:
    type: celerity
    path: ./services/orders-api
    port: 8081
    mode: dev
    plugin:
      deployTarget: aws
    compose: .celerity/compose.yaml
    dependsOn: [users-api]

  # Backend service — handled by core (no plugin)
  notification-worker:
    type: service
    path: ./services/notification-worker
    command: "go run ./cmd/worker"
    containerImage: notification-worker:latest
    port: 8082
    hostPort: 18082                    # optional: host-mapped port (defaults to port)
    mode: dev
    compose: docker-compose.dev.yaml
    env:
      WORKER_CONCURRENCY: "5"
    hooks:
      preStart: scripts/migrate.sh
      postStart: scripts/seed.sh
      preStop: scripts/cleanup.sh
    dependsOn: [orders-api]

  # Init-task service — runs migration then exits
  api-migrator:
    type: service
    path: ./services/api
    mode: container
    containerImage: api-migrator:latest
    initTask: true                     # must exit 0 before dependents start
    dependsOn: [notification-worker]

  # Frontend app — handled by core (no plugin)
  web-app:
    type: app
    path: ./apps/web
    command: "npm run dev"
    port: 3000
    mode: dev
    proxy:
      domain: myapp.dev              # custom domain for OAuth redirects
    hooks:
      preStart: scripts/codegen.sh
    dependsOn: [users-api, orders-api]

# Workspace-level compose override — string form (simple path)
# extraCompose: .lo1/compose.override.yaml

# Object form — with init-task service declarations
extraCompose:
  file: .lo1/compose.override.yaml
  initTaskServices: [localstack_init]  # services that must exit 0 before startup continues

# Workspace-level hooks
hooks:
  postInfrastructure: .lo1/hooks/post-infra.sh
  postSetup: .lo1/hooks/post-setup.sh
  preStop: .lo1/hooks/pre-stop.sh
```

---

## 7. Shared Infrastructure Compose Strategy

### Union Across Plugins

1. The orchestrator calls `contributeCompose()` on each plugin with all its services
2. Each plugin returns compose service definitions
3. The orchestrator merges all contributions into a single compose file
4. Service-level compose overrides are layered via Docker Compose `-f` flags
5. Workspace-level override is applied last
6. `generateCompose()` returns `infraServices[]` and `appServices[]` arrays

### Two-Phase Startup

Infrastructure and app services are started separately using the same compose project but targeting specific services:

```
# Phase 1: Infrastructure (plugin contributions + proxy)
docker compose -p lo1-my-platform \
  -f .lo1/compose.generated.yaml \
  -f ... \
  up -d --build --wait dynamodb valkey lo1-my-platform-proxy

# Phase 2: App services (container-mode user services)
docker compose -p lo1-my-platform \
  -f .lo1/compose.generated.yaml \
  -f services/notification-worker/docker-compose.dev.yaml \
  -f ... \
  up -d --build --wait notification-worker
```

`--wait` handles both long-running services (waits until healthy/running) and one-off containers (considers exit code 0 as success).

### Compose File Layering

```
docker compose -p lo1-my-platform \
  -f .lo1/compose.generated.yaml \                          # generated (all plugins)
  -f services/users-api/.celerity/compose.yaml \            # service overrides
  -f services/orders-api/.celerity/compose.yaml \
  -f services/notification-worker/docker-compose.dev.yaml \
  -f .lo1/compose.override.yaml \                           # workspace override (last)
  up -d --build --wait <service-names...>
```

### Service-Level `compose` Field

The `compose` field on a service config serves two purposes depending on context:

- **Plugin services** (e.g. `type: celerity`): overrides or extends plugin-generated compose definitions (additional volumes, env vars, resource limits)
- **Container-mode `service`/`app`**: defines the service's own container (build context, Dockerfile, volumes for hot reload, dev command). This is how non-plugin services run in containers — the compose file IS their container definition.

Example for a container-mode service:
```yaml
services:
  api:
    type: service
    path: ./api
    port: 3499
    mode: container
    compose: docker-compose.dev.yaml     # defines build, volumes, command for dev container
    dependsOn: [db]
```

Where `api/docker-compose.dev.yaml` defines build context, Dockerfile, volume mounts for hot reload, and dev command.

### Generated Compose Includes

**Infrastructure services** (`infraServices[]`):
- Plugin compose contributions (DynamoDB Local, Valkey, MinIO from Celerity plugin)
- Caddy proxy container (if proxy enabled)

**App services** (`appServices[]`):
- Container-mode `service`/`app` types (from `containerImage` or `compose` field)
- Any plugin-type services running in container mode (container config from plugin)

---

## 8. Reverse Proxy & Local Domains

### Caddy Proxy

- Auto-added to compose stack when proxy enabled
- Configurable TLD (default `.local`) — essential for OAuth/SSO/PWA testing
- Subdomain routing by default: `users-api.my-platform.local`
- Path-based routing option: `my-platform.local/api/users/*`
- Custom domain option: `myapp.dev` (for OAuth redirect URIs)

### `/etc/hosts` Management

```
lo1 hosts              # output entries to stdout
lo1 hosts --apply      # write managed block to /etc/hosts (sudo)
lo1 hosts --remove     # remove managed block (sudo)
```

### Local TLS via Caddy

TLS is handled entirely by Caddy's `tls internal` directive — no mkcert or external cert generation needed. When `proxy.tls.enabled` is `true`:

1. **Auto-trust during `lo1 up`** — after the compose stack is healthy, the orchestrator checks whether the Caddy root CA is already trusted. If not, it runs `caddy trust` to install the CA into the host trust store. This is a one-time operation that persists across restarts.
2. **`lo1 tls-setup`** — manual fallback command that runs the same trust flow. Useful if the CA was removed from the trust store or for troubleshooting.

```
lo1 tls-setup          # manual: runs `caddy trust` to install Caddy root CA in host trust store
```

---

## 9. Startup Orchestration

### Startup Sequence

1. **Load config** — parse `lo1.yaml`, validate with Zod
2. **Load plugins** — dynamic `import()` for each declared plugin
3. **Validate** — detect dependency cycles, unknown types, missing plugin declarations
4. **Plugin compose contributions** — call `contributeCompose()` on each plugin
5. **Generate unified compose** — merge all contributions + proxy + service overrides. Returns `infraServices[]` (plugin contributions + proxy) and `appServices[]` (container-mode user services)
6. **Generate Caddyfile** from proxy config
7. **Start infrastructure** — `docker compose up -d --build --wait <infraServices>` (waits until healthy/exited-0)
8. **Start app compose services** — `docker compose up -d --build --wait <appServices>` (if any)
9. **TLS trust** — if `proxy.tls.enabled`, check Caddy root CA and run `caddy trust` if not already trusted
10. **Workspace `postInfrastructure` hook**
11. **Plugin provisioning** — call `provisionInfra()` per plugin service (parallel within same plugin)
12. **Plugin seeding** — call `seedData()` per plugin service (parallel)
13. **Start services** in dependency order (layer by layer, parallel within layer):
    a. **Service `preStart` hook**
    b. **Start service** (container via plugin's `configureContainer()`, or host process via core runner)
    c. **Plugin `watchForChanges()`** (if plugin provides it)
    d. **Service `postStart` hook**
14. **Workspace `postSetup` hook**
15. **Report ready**

### Shutdown Sequence

1. **Workspace `preStop` hook**
2. **Stop services** in reverse dependency order (service `preStop` hook, then stop)
3. **Stop infrastructure** — `docker compose down` (or `docker compose down -v --remove-orphans` with `--clean`)
4. **Remove state file** — `.lo1/state.json` deleted

Note: `/etc/hosts` entries are **not** removed during shutdown — this avoids requiring sudo on every teardown. Run `lo1 hosts --remove` manually to clean up.

### Hook Execution

- All hooks run on the host machine via `node:child_process` spawn
- Receive plugin-contributed env vars (localhost-translated) + `LO1_SERVICE_<NAME>_URL` vars
- Service hooks resolved relative to service `path`; workspace hooks relative to workspace root
- Non-zero exit halts startup with clear error
- Output streamed to stdout and written to `.lo1/logs/hooks.log`

---

## 10. Service Runners (Core)

Services run in one of three ways depending on `mode` and `type`:

1. **Host process** — dev-mode services with `type: service` or `type: app` (no plugin). Runs `command` on host via `sh -c`.
2. **Plugin-configured container** — dev or container-mode services where the plugin provides `configureContainer()`. Runs in a Docker container with mounted project dir + hot reload. Uses `docker run` directly (not compose).
3. **Compose-managed container** — container-mode `service`/`app` types with a `compose` field pointing to a service-level compose file (defines build context, volumes, dev command for hot reload), or `containerImage` for pre-built images. Also includes plugin compose contributions (DynamoDB, Redis, etc.). Managed by Docker Compose (`docker compose up`).

```typescript
type OutputLine = {
  service: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: Date;
};
```

### ProcessRunner — host process (mode 1)

- Runs `command` as subprocess via `node:child_process` spawn on the host
- Uses platform shell (`sh -c` on unix, `cmd.exe /c` on Windows)
- Working directory set to service `path`
- Inherits `LO1_SERVICE_*` and infrastructure env vars (localhost-translated)
- Streams stdout/stderr via `onOutput` callback
- Returns `ProcessHandle` with `stop()` (SIGTERM → SIGKILL after timeout) and `exitPromise`

### ContainerRunner — plugin-configured container (mode 2)

- Runs a single Docker container from a plugin's `ContainerConfig` via `docker run -d`
- Deterministic naming: `--name lo1-{workspaceName}-{serviceName}`
- Joins the lo1 bridge network (`--network {networkName}`)
- Mounts project dirs via `-v` binds for hot reload
- Streams logs via `docker logs -f`
- `stop()` calls `docker stop` then `docker rm`

### ComposeExecutor — infrastructure containers (mode 3)

- Thin wrapper around `docker compose` CLI
- `composeUp`: `docker compose -p {project} -f {files...} up -d --wait`
- `composeDown`: `docker compose -p {project} -f {files...} down`
- `composePs`: `docker compose -p {project} -f {files...} ps --format json` (parses NDJSON)

---

## 11. Service Discovery

```typescript
type ServiceEndpoint = {
  name: string;
  port: number;           // container/application port
  hostPort: number;       // host-mapped port (defaults to port when not specified)
  internalUrl: string;    // container-to-container: http://users-api:5432 (Docker DNS)
  externalUrl: string;    // host-to-host: http://localhost:15432 (uses hostPort)
  proxyUrl: string;       // browser access: https://users-api.my-platform.local
  mode: "dev" | "container" | "skip";
};
```

**Consumer modes** determine which URLs a service receives:

- `"container"` — internal URLs (`http://{name}:{port}`), for services running inside Docker (container-mode, or dev-mode with plugin-configured container)
- `"host"` — external URLs (`http://localhost:{hostPort}`), for services running as host processes (dev-mode with `type: service/app`)

**Env vars injected into each service:**

- `LO1_SERVICE_{KEY}_URL` — internal or external URL depending on consumer mode
- `LO1_SERVICE_{KEY}_PORT` — container port for container consumers, host port for host consumers
- `LO1_SERVICE_{KEY}_PROXY_URL` — browser-accessible proxy URL
- `LO1_SERVICE_NAME` — current service name
- `LO1_WORKSPACE_NAME` — workspace name
- All plugin-contributed env vars (e.g. `CELERITY_LOCAL_DATASTORE_ENDPOINT`)
- Plugin env var translation: for host consumers, container hostnames are replaced with `localhost` and ports are remapped to `hostPort`

---

## 12. Output & Log Files

### Headless Output

`lo1 up` runs in headless mode exclusively — structured status lines to stdout with color-coded `[prefix]` tags:

```
[lo1] Loading config
[lo1] Starting infrastructure
[infrastructure] #1 Building api...
[lo1] Starting compose services
[lo1] api: starting
[api] Server listening on :3000
[lo1] Ready
```

**Color coding** (TTY-aware — no colors when piped):
- `[lo1]` — bold cyan (phase and service status events)
- `[error]` — red
- `[hook]` — yellow
- `[service-name]` — cycles through an 8-color palette, consistent per service within a session

**Output suppression:**
- Proxy service output (`*-proxy`) is written to log files but **not** shown on stdout — reduces noise
- After the `Ready` phase, all service output is suppressed from stdout (log files only). Use `lo1 logs` to tail.

All output events are simultaneously written to per-service log files under `.lo1/logs/`:

```
.lo1/logs/
  infrastructure.log   # docker compose build/pull output
  api.log              # per-service container + process output
  web.log
  hooks.log            # hook execution output
```

Each line is timestamped: `[2026-02-16T10:30:00.000Z] Server listening on :3000`

### `lo1 logs` Command

```
lo1 logs              # tail all log files (interleaved with [service] prefix)
lo1 logs <service>    # tail a specific service's log file
lo1 logs --list       # list available log files
```

Cross-platform: uses `tail -f` on macOS/Linux, `Get-Content -Wait` on Windows.

---

## 13. CLI Commands

```
lo1 init         [--config lo1.yaml]
lo1 up           [--services a,b] [--mode dev|container] [-d|--detach] [--skip-teardown] [--clean]
lo1 down         [--clean]
lo1 status       [--json]
lo1 logs         [service] [--list]
lo1 hosts        [--apply | --remove]
lo1 tls-setup
```

**`lo1 up` flags:**
- `-d, --detach` — Start services and exit immediately (like `docker compose up -d`)
- `--skip-teardown` — On Ctrl+C, leave containers running for debugging. Run `lo1 down` to clean up.
- `--clean` — On teardown, remove volumes and orphan containers (`docker compose down -v --remove-orphans`)

**`lo1 down` flags:**
- `--clean` — Remove volumes and orphan containers (fresh slate)

---

## 14. Headless & Automation (L8)

Features that make lo1 equally usable by scripts and automation tooling as by a human at a terminal.

### `lo1 status --json`

Machine-readable output for querying service state:

```json
{
  "workspace": "my-platform",
  "services": [
    { "name": "users-api", "state": "running", "mode": "dev", "port": 8080, "hostPort": 8080 },
    { "name": "orders-api", "state": "running", "mode": "container", "port": 8081, "hostPort": 8081 }
  ],
  "infrastructure": {
    "state": "healthy",
    "services": ["datastore", "valkey", "proxy"]
  }
}
```

### `lo1 logs [service]` (implemented in L5)

Tails per-service log files from the most recent `lo1 up` session:

- `lo1 logs` — tail all log files (interleaved with `[service]` prefix)
- `lo1 logs <service>` — tail a specific service's log file
- `lo1 logs --list` — list available log files
- Output is plain text to stdout, suitable for piping

### Host Process Readiness Probes

Optional `readinessProbe` in service config for host processes (compose services already have health checks via `--wait`):

```yaml
services:
  users-api:
    type: service
    port: 8080
    command: "bun run dev"
    readinessProbe: http://localhost:8080/health
```

- HTTP GET probe — service is ready when probe returns 2xx
- Orchestrator waits for readiness before starting dependent services
- Timeout + retry with backoff, failure halts startup with clear error
- If not specified, service is considered ready immediately after process starts (current behaviour)

### Structured Error Output

All commands emit structured errors when run with `--json`:

```json
{ "error": "CycleDetected", "message": "Dependency cycle detected: A → B → C → A", "services": ["A", "B", "C"] }
```

Non-JSON mode continues to emit human-readable errors. Exit codes are non-zero on failure.

### Debug Logging

Uses the [`debug`](https://www.npmjs.com/package/debug) package for fine-grained diagnostic output, controlled via the `DEBUG` environment variable. Zero overhead when disabled — no log strings are constructed.

**Scopes:**

| Scope | Covers |
|-------|--------|
| `lo1:config` | Config loading, Zod validation, schema resolution |
| `lo1:dag` | Dependency graph construction, cycle detection, topological sort layers |
| `lo1:compose` | Compose file generation, layering, `docker compose` invocations |
| `lo1:runner:process` | Host process spawn, env injection, exit codes |
| `lo1:runner:container` | `docker run` args, log streaming, stop/rm |
| `lo1:runner:compose` | `docker compose up/down/ps` commands and output |
| `lo1:discovery` | Endpoint registry, env var generation, plugin env var translation |
| `lo1:proxy` | Caddyfile generation, hosts file management, TLS setup |
| `lo1:hooks` | Hook resolution, execution, env, exit codes |
| `lo1:plugin` | Plugin loading, lifecycle method invocations |
| `lo1:orchestrator` | Startup/shutdown state transitions, layer execution order |

**Usage:**

```bash
# All lo1 debug output
DEBUG=lo1:* lo1 up

# Only orchestrator + runner output
DEBUG=lo1:orchestrator,lo1:runner:* lo1 up

# Combined with external debug scopes
DEBUG=lo1:*,docker:* lo1 up
```

Each scope is created per-module via `import debug from "debug"` and `const log = debug("lo1:compose")`. Plugins use their own namespace (e.g. `lo1:plugin:celerity`).

**Output routing:**

`debug` writes to stderr as normal — debug output flows alongside the `[service]`-prefixed stdout lines and can be separated via standard shell redirection (`2>/dev/null` or `2>debug.log`).

---

## 15. Multi-Repo Bootstrap

`repositories` section in manifest maps service names to Git URLs + local paths.

```
lo1 init
```

Clones missing repos, skips existing ones. Idempotent.

---

## 16. Implementation Stages

Priority: core working for `service`/`app` types (immediate use case: proprietary system migration). Celerity plugin deferred to future.

| Stage | Scope | Key Deliverables | Status |
|-------|-------|-----------------|--------|
| L1 | Project scaffold | Bun workspace monorepo, `@lo1/sdk` + `@lo1/cli` packages, Commander CLI skeleton, commitlint + git hooks, ESLint + Prettier, tsconfig, CI workflow | Done |
| L2 | Config + DAG | `lo1.yaml` loader with Zod validation, dependency DAG with topological sort + cycle detection, `lo1 init` (repos) | Done |
| L3 | Compose + proxy | Compose generation (core services in container mode + plugin contributions), layered overrides, Caddyfile generation, hosts/TLS commands (Caddy `tls internal`) | Done |
| L4 | Runners + discovery | Plugin loader, service discovery + env var injection, hook executor, ProcessRunner (host), ContainerRunner (`docker run`), ComposeExecutor (`docker compose` CLI) | Done |
| L5 | Orchestrator + output | Startup/shutdown state machine, `lo1 up` / `lo1 down` / `lo1 status`, two-phase compose (infra then app), per-service log files (`.lo1/logs/`), `lo1 logs` command, AbortController coordination, `--detach`/`--skip-teardown`/`--clean` flags, color-coded output with TTY detection, proxy output suppression, post-Ready output suppression | Done |
| L6 | Headless + automation | `--json` flag on `lo1 status`, host process readiness probes (`readinessProbe` in service config), structured error output (exit codes + JSON errors), `debug` package logging with `lo1:*` scopes | |

---

## 17. Verification

1. **Config loading**: Parses `lo1.yaml` with all service types, repos, proxy, hooks, plugins
2. **Validation**: Rejects invalid types, missing fields, nonexistent paths, undeclared plugin types
3. **Cycle detection**: Rejects `A->B->C->A` with clear error
4. **Topological sort**: `A->[], B->[A], C->[A], D->[B,C]` → layers `[[A], [B,C], [D]]`
5. **Repo init**: Clones missing repos, skips existing (idempotent)
6. **Plugin loading**: Loads plugins via dynamic import, rejects missing/invalid plugins
7. **Plugin compose contribution**: Plugin returns compose service definitions, merged into generated compose
8. **Compose layering**: Service overrides merged correctly via `-f` flags
9. **Proxy (subdomain)**: Caddyfile routes `users-api.my-platform.local` → `users-api:8080`
10. **Proxy (custom domain)**: `myapp.dev` generates correct Caddyfile + hosts entries
11. **Local TLS**: Caddy `tls internal` serves auto-generated certs, `caddy trust` installs root CA on host
12. **Hosts management**: `--apply` writes managed block, `--remove` cleans up
13. **Workspace hooks**: `postInfrastructure`, `postSetup`, `preStop` execute at correct lifecycle points
14. **Service hooks**: `preStart`/`postStart`/`preStop` per service, with correct env vars
15. **Hook failure**: Non-zero exit halts startup with clear error message
16. **Process runner**: Starts subprocess, streams output, stops on cancellation
17. **Container runner**: Plugin-configured container starts on shared network
18. **Service discovery**: Each service receives correct `LO1_SERVICE_*` env vars
19. **`lo1 up`**: Full lifecycle — infra stack → app stack → hooks → provision → seed → services (dependency order)
20. **`lo1 down`**: Hooks → stop services → stop infra
21. **Selective start**: `--services orders-api` includes transitive dep `users-api`
22. **Headless output**: Status lines + interleaved `[service-name]` prefixed logs to stdout
23. **Log files**: Per-service log files in `.lo1/logs/`, `lo1 logs <service>` tails correctly

---

## 18. Future

Deferred work — revisit when time permits.

### Celerity Plugin

```typescript
// plugins/celerity/src/index.ts

import type { PluginFactory } from "@lo1/sdk";

const createPlugin: PluginFactory = (context) => ({
  name: "celerity",

  async contributeCompose(input) { /* ... */ },
  async provisionInfra(input) { /* ... */ },
  async seedData(input) { /* ... */ },
  async configureContainer(input) { /* ... */ },
  async *watchForChanges(input) { /* ... */ },
});

export default createPlugin;
```

#### contributeCompose

- Loads blueprint from each service's path (auto-detects `app.blueprint.yaml` / `app.blueprint.jsonc`)
- Collects **union** of resource types across all blueprints
- Returns compose services — same mapping logic as existing Celerity CLI (ported from Go):
  - `celerity/datastore` → DynamoDB Local (cloud-specific, from `deployTarget` in plugin config)
  - `celerity/bucket` → MinIO
  - `celerity/queue`, `celerity/topic`, `celerity/config`, `celerity/cache` → shared Valkey
- Returns `CELERITY_LOCAL_*` env vars

#### provisionInfra

- Ports logic from existing Celerity CLI `internal/seed/provisioner.go` (ProvisionFromBlueprint)
- Creates DynamoDB tables, MinIO buckets from each service's blueprint
- Idempotent — skips existing tables/buckets (safe for cross-service duplicates)

#### seedData

- Ports logic from existing Celerity CLI `internal/seed/executor.go`
- Discovers seed data from `<service-path>/.celerity/seed/` (or `seed-test/` for test mode)
- Applies NoSQL records, storage files

#### configureContainer

- Returns Celerity runtime container config:
  - Image: `ghcr.io/newstack-cloud/celerity-runtime-{lang}-{version}:dev-<version>` (resolved from blueprint runtime field — e.g. `nodejs-22`, `python-3.12`, `dotnet-9`, `java-21`, `go-1.24`)
  - Cmd: `["dev"]` for dev mode (enables `--watch-path` hot reload)
  - Bind mounts: app source → `/opt/celerity/app`, merged blueprint → `/opt/celerity/merged.blueprint.yaml`
  - Env vars: `CELERITY_BLUEPRINT`, `CELERITY_MODULE_PATH`, `CELERITY_SERVICE_NAME`, etc.

#### watchForChanges

- Async generator that watches for handler changes via chokidar
- File patterns are runtime-aware (e.g. `.ts`/`.js` for Node.js, `.py` for Python, `.cs` for .NET, `.java` for Java, `.go` for Go)
- Re-extracts handler metadata via the extraction CLI
- Re-merges into blueprint
- Yields `RestartSignal` when handlers change (logic changes handled by container's `--watch-path`)

#### Cross-Service Async Communication

Convention-based: services sharing queues/topics declare the same `spec.name` in their blueprints. Both runtimes connect to the shared Valkey instance and use the same stream name. No explicit cross-service wiring needed.

#### Porting from Existing Celerity CLI

The Celerity plugin will port logic from these existing Go files in the Celerity CLI (`apps/cli/`):

| Existing Go File | Ported To |
|---|---|
| `internal/compose/generator.go` | `plugins/celerity/src/compose.ts` — resource type → emulator mapping |
| `internal/compose/types.go` | `plugins/celerity/src/compose.ts` — constants, image names, port mappings, env var names |
| `internal/seed/provisioner.go` | `plugins/celerity/src/provision.ts` — blueprint → table/bucket creation |
| `internal/seed/executor.go` | `plugins/celerity/src/seed.ts` — convention dir discovery + data application |
| `internal/seed/dynamodb.go` | `plugins/celerity/src/provision.ts` — DynamoDB-specific provisioner |
| `internal/seed/minio.go` | `plugins/celerity/src/provision.ts` — MinIO-specific provisioner + uploader |

### Docs Website

Parity with bluelink.dev and celerityframework.io in style and quality. Likely same docs framework (to be determined when the time comes). Domain: `lo1.dev`.

---

## Related: Single-Service `celerity dev run`

The existing single-service dev flow (Stages 1-4 in `apps/cli/docs/dev-commands/`) remains in the Celerity CLI unchanged. Developers use `celerity dev run` for quick single-service work and `lo1 up` when they need the full system.
