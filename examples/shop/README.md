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

`lo1 up` asks for `sudo` once, to add `api.shop.local` and `web.shop.local` to your hosts file and trust lo1's local certificate authority. On Linux, install `certutil` first (`sudo apt install libnss3-tools` on Debian and Ubuntu) so Chrome and Firefox trust it too. On Windows, a UAC prompt updates the hosts file unless PowerShell is running as Administrator, and Windows asks you to confirm the certificate; if Windows Firewall asks about Docker and Node.js, allow them on private networks. It then starts Postgres, runs `migrate` and `seed`, starts the API, waits for its health check, and starts the web app:

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
- The web app finds the API through `LO1_SERVICE_API_PROXY_URL`, which lo1 sets for every service, and the API only accepts browser requests from the web app's URL, `LO1_SERVICE_WEB_PROXY_URL`. See [`web/src/config.js`](./web/src/config.js) and [`api/src/config.js`](./api/src/config.js).

## How the code is organised

The services are small, but they're laid out the way a real one would be. Each module has one job, and each depends only on what it's given.

| File | Its one job |
| --- | --- |
| [`api/src/config.js`](./api/src/config.js) | Reads the environment, once. Nothing else touches `process.env`. |
| [`api/src/server.js`](./api/src/server.js) | The composition root: creates the pool and starts the server. |
| [`api/src/app.js`](./api/src/app.js) | Wires repositories and routes together into a request handler. |
| [`api/src/http/router.js`](./api/src/http/router.js) | Dispatches requests to routes. A new endpoint is a new route; the router doesn't change. |
| [`api/src/products/`](./api/src/products/) | The product routes, and the repository that holds all the product SQL. |
| [`api/src/migrations/`](./api/src/migrations/) | Numbered migrations, recorded in `schema_migrations` so each runs once. To change the schema, add a file. |
| [`web/src/handler.js`](./web/src/handler.js) | Serves the page's files and `/config.json`, with a content security policy. |
| [`web/public/app.js`](./web/public/app.js) | Fetches the products and renders them with `textContent`, never `innerHTML`. |

## Run the tests

```bash
cd api && npm install && npm test   # starts a throwaway Postgres in Docker first
cd web && npm test
```

The API's tests run against real Postgres, from [`api/test/compose.yaml`](./api/test/compose.yaml), on port 54330, so they can run alongside `lo1 up`. Each test file works in its own schema. Stop the test database with `npm run test:db:down`.
