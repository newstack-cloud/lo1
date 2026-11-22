# lo1

lo1 runs a multi-service system locally: it orchestrates services, shared infrastructure in
docker compose, and a Caddy reverse proxy with local domains and TLS, configured by `lo1.yaml`
and extended by runtime plugins. A Bun monorepo publishing `@lo1/cli`, `@lo1/sdk` and
`@lo1/plugin-celerity` to npm. No package depends on another NewStack repo today; the planned
Celerity plugin will follow Celerity's blueprint format and runtime images.

## Workspace

This repo is one of NewStack's. NewStack's maintainers develop it alongside the others in a
shared workspace, using the NewStack Claude Code plugin for how work is planned, reviewed,
committed and coordinated across repos. The plugin isn't public, and nothing here depends on it:
this file and the repo's own docs cover what a contribution needs.

## Layout

| Path | Holds |
|---|---|
| `packages/cli` | The `lo1` command: config, dependency graph, compose and process runners, proxy, hosts file, TLS, `doctor` |
| `packages/sdk` | Plugin SDK: types, Zod config schemas, and the generated JSON Schema in `schemas/` |
| `plugins/celerity` | A placeholder for the Celerity plugin: no lifecycle methods yet |
| `examples/shop` | An example workspace; separate Node projects with their own `npm test`, outside `bun test`, though `packages/cli/tests/config/examples.test.ts` validates each example's `lo1.yaml` |

## Checks

Commands are in [CONTRIBUTING.md](CONTRIBUTING.md); all run from the root across packages.

- **Tools:** Bun 1.4 or later (`bunfig.toml` needs it), and Node 24 to run the built CLI.
  Run `bun install` first; the hooks need it.
- **Build first:** the CLI and plugin import `@lo1/sdk` from its `dist/`, so run
  `bun run build` after changing the SDK, before CLI tests or typecheck see it. The build also
  regenerates the SDK's JSON Schema (`bun run --filter @lo1/sdk build:schema` alone); commit it
  with a schema change, since CI doesn't check it's fresh.
- **Tests:** `bun test` (or `bun --filter @lo1/sdk test`). Docker, git and the trust-store
  commands are mocked; some tests spawn short-lived shell processes, bind a loopback port and
  use temp directories, and none touch docker, the hosts file or the network.
  `bun run test:coverage` is CI's check: aggregate thresholds in `scripts/check-coverage.ts`
  (77% lines, 76% functions). `examples/shop/api`'s `npm test` starts a docker Postgres and
  leaves it running until `npm run test:db:down`.
- **Lint and types:** `bun run lint` (ESLint on `packages/` and `plugins/`),
  `bun run format:check` (Prettier on package `src` only), `bun run typecheck` (tests aren't
  type-checked).
- **Gates:**
  - With `git config core.hooksPath .githooks`, pre-commit runs lint and `format:check` when
    staged changes touch `packages/` or `plugins/`, and commit-msg runs commitlint.
  - CI (`ci.yml`) runs format, `bun audit --audit-level high --ignore GHSA-fc5q-39xc-vjpf`,
    lint, build, typecheck, `test:coverage` and SonarCloud on pull requests and pushes to
    `main`. `codeql.yml` runs CodeQL on the same triggers and weekly; `security.yml` runs
    actionlint on pull requests.

## Running locally

Running the built CLI acts on the host, not just the repo:

- `lo1 up` starts docker containers, host processes for dev-mode services and hooks, and a Caddy
  proxy on host ports 80 (and 443 with TLS) by default.
- The proxy is on by default, so `lo1 up` writes local domains to the hosts file: through `sudo`
  on macOS and Linux, through an elevated PowerShell on Windows. It's one global block, so `up`
  in another workspace replaces it.
- With TLS, it adds lo1's certificate authority to the trust store: the login keychain on macOS,
  the user Root store on Windows, and on Linux the system store through `sudo` plus Chrome and
  Firefox through `certutil`. ACME mode instead reaches a real DNS provider and CA with the
  user's credentials.
- `lo1 down` leaves the hosts block and the certificate authority in place; `lo1 hosts --remove`
  clears the block. Plain `lo1 hosts` only prints it, and `--apply` writes it.

## Compatibility

- **`lo1.yaml`:** the config schema in `@lo1/sdk` (`version: "1"`) is what users' workspaces
  are written against; a rename or removal breaks them. The generated JSON Schema sets
  `additionalProperties: false`, so editors reject a new field until the schema is released.
- **Plugin SDK:** third-party plugins build against `@lo1/sdk`'s types and a default-exported
  factory. Mark a breaking SDK or schema change with `!` or `BREAKING CHANGE:` (release-please
  bumps the minor version before 1.0), and say in the pull request what plugins or `lo1.yaml`
  files need.
- **Persisted state:** `.lo1/state.json` in each workspace is read back by `down`, `status`,
  `restart` and `tls-setup`, so a change to its shape can strand a workspace started by an
  older CLI. The compose file and Caddyfile are regenerated on every `up`.

## Conventions

- Commits: conventional, with the types and scopes in `commitlint.config.js` (`cli`, `sdk`,
  `plugin-celerity`, `ci`, `repo`, `deps`).
- Releases: release-please with linked versions across the three packages; merging a release
  pull request publishes them to npm through trusted publishing. Don't edit `CHANGELOG.md`
  files, versions or `.release-please-manifest.json` by hand.
- Prettier (100 columns, double quotes, trailing commas) and ESLint (`_` prefix for unused
  variables) set the code style; the newstack plugin's `typescript-standards-lo1` skill has the
  rest.

## Safety

- Don't run `lo1 up`, `down`, `restart`, `init` (which clones repositories), `hosts --apply` or
  `--remove`, or `tls-setup` unless asked: they change the hosts file and trust store, start or
  stop a workspace's containers and processes, or reach the network.
- Don't publish to npm, dispatch the release workflow, create tags or releases, or merge
  release pull requests.

## Known mistakes

<!-- One line per mistake an agent has made here, phrased as the rule that prevents it. -->
