# Contributing

## Prerequisites

- Bun >= 1.1

## Getting Started

```bash
# Clone the repository
git clone git@github.com:newstack-cloud/lo1.git
cd lo1

# Install dependencies
bun install

# Set up git hooks for conventional commits
git config core.hooksPath .githooks

# Build all packages
bun run build

# Run tests
bun test
```

## Development

```bash
# Type checking across all packages
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Format check (CI)
bun run format:check

# Clean build artifacts
bun run clean
```

## Managing Dependencies

Use `--filter` to target a specific package:

```bash
# Add a runtime dependency to a package
bun --filter @lo1/sdk add some-package

# Add a dev dependency to a package
bun --filter @lo1/sdk add -D some-package

# Add a workspace dependency (reference another package in the monorepo)
bun --filter @lo1/cli add @lo1/sdk@workspace:*

# Run a script in a specific package
bun --filter @lo1/sdk run build
```

## Testing

```bash
# Run all tests
bun test

# Run tests with aggregate coverage thresholds (same as CI)
bun run test:coverage

# Run tests with per-file coverage table (no threshold check)
bun test --coverage

# Run tests for a specific package
bun --filter @lo1/sdk test
```

Coverage thresholds are enforced at the **aggregate** level (not per-file) via
`scripts/check-coverage.ts`. Edit the `THRESHOLDS` constant to adjust.

## Conventional Commits

This project uses [conventional commits](https://www.conventionalcommits.org/) enforced by commitlint.

Format: `type(scope): description`

**Types**: `feat`, `fix`, `build`, `revert`, `wip`, `chore`, `ci`, `docs`, `style`, `refactor`, `perf`, `test`, `instr`, `deps`

**Scopes**: `cli`, `sdk`, `plugin-celerity`, `ci`, `repo`, `deps`

Examples:
```
feat(cli): add service status dashboard
fix(sdk): correct proxy config schema validation
deps(cli): update commander to v13
chore: update TypeScript to 5.8
```
