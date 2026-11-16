# Shop example

A small system for trying lo1: a web frontend, an API and Postgres, with a database migration and seed data that run before the API starts.

```
postgres (infra.compose.yaml)
   └─ migrate (init task) ─ seed (init task) ─ api ─ web
```

You need Node.js 24+ and Docker. Run `lo1 doctor` to check.

## Run it

```bash
npx degit newstack-cloud/lo1/examples/shop shop
cd shop
lo1 up
```

`lo1 up` asks for `sudo` once, to add `api.shop.local` and `web.shop.local` to your hosts file and trust lo1's local certificate authority. It then starts Postgres, runs `migrate` and `seed`, starts the API, waits for its health check, and starts the web app:

```
  Workspace shop is ready in 4.1s
    infrastructure 2.4s · services 1.7s

  Services:
    api  https://api.shop.local
    web  https://web.shop.local
```

Open https://web.shop.local to see the products, read from Postgres through the API.

## Things to try

| Command                  | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `lo1 status`             | Shows each service's health. Exits 0 when everything is up.     |
| `lo1 logs api`           | Tails the API's log.                                            |
| `lo1 restart seed`       | Runs the seed again, putting the products back how they started. |
| `lo1 restart api`        | Restarts the API and waits for its health check.                |
| `lo1 up --detach`        | Starts everything in the background and returns once it's ready. |
| `lo1 down`               | Stops everything. Add `--clean` to delete the database volume.  |

## How it fits together

- [`lo1.yaml`](./lo1.yaml) lists the services. `migrate` and `seed` are init tasks: they run once, in order, and must exit 0 before anything that depends on them starts.
- [`infra.compose.yaml`](./infra.compose.yaml) is an ordinary Docker Compose file for Postgres. lo1 waits for its health check before running the migration.
- The web app finds the API through `LO1_SERVICE_API_PROXY_URL`, which lo1 sets for every service. See [`web/server.js`](./web/server.js).
