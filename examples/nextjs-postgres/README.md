# Next.js + Postgres example

A Next.js app that reads rows from Postgres, run by lo1. A database migration and seed run before the app starts.

```
postgres (infra.compose.yaml)
   └─ migrate (init task) ─ seed (init task) ─ web (next dev)
```

You need Node.js 24+ and Docker. Run `lo1 doctor` to check.

## Run it

```bash
npx degit newstack-cloud/lo1/examples/nextjs-postgres nextjs-postgres
cd nextjs-postgres
lo1 up
```

`lo1 up` asks for `sudo` once, to add `web.nextjs-postgres.local` to your hosts file and trust lo1's local certificate authority. See the [shop example](../shop/README.md#run-it) for the details on Linux and Windows. It then starts Postgres, runs `migrate` and `seed`, and starts `next dev`.

Open https://web.nextjs-postgres.local to see the notes, read from Postgres by a server component. Edit [`web/app/page.js`](./web/app/page.js) and the page reloads.

## Things to try

| Command            | What it does                                                          |
| ------------------ | --------------------------------------------------------------------- |
| `lo1 status`       | Shows each service's health. Exits 0 when everything is up.           |
| `lo1 logs web`     | Tails the Next.js dev server's log.                                   |
| `lo1 restart seed` | Runs the seed again, putting the notes back how they started.         |
| `lo1 down`         | Stops everything. Add `--clean` to delete the database volume.        |

## How it fits together

- [`lo1.yaml`](./lo1.yaml) lists the services. `migrate` and `seed` are init tasks: they run once, in order, and must exit 0 before anything that depends on them starts. `migrate` also runs `npm install`, so the first start needs no setup.
- [`infra.compose.yaml`](./infra.compose.yaml) is an ordinary Docker Compose file for Postgres, with a `healthcheck`. lo1 waits for it to be healthy before running the migration.
- `web` is a `type: app` service that runs `next dev` on its own port (4300), taken from `PORT`. lo1 serves it at `https://web.nextjs-postgres.local`.
- `DATABASE_URL` is set once in `lo1.yaml` (as a YAML anchor) and shared by `migrate`, `seed` and `web`. The Postgres host port is 54331, an uncommon one so it doesn't clash with a local Postgres.
- [`web/next.config.mjs`](./web/next.config.mjs) lists the lo1 host name in `allowedDevOrigins`, so Next.js accepts dev-only requests such as hot reloading from it.

## The code

The app is plain JavaScript with `pg` and no ORM, so the example stays about lo1.

| File | What it does |
| --- | --- |
| [`web/lib/db.js`](./web/lib/db.js) | Creates the connection pool from `DATABASE_URL`. |
| [`web/app/page.js`](./web/app/page.js) | A server component that queries the `notes` table and renders it. |
| [`web/scripts/migrate.js`](./web/scripts/migrate.js) | Creates the `notes` table if it doesn't exist. |
| [`web/scripts/seed.js`](./web/scripts/seed.js) | Replaces the rows in `notes` with a few notes. |
