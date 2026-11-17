import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

// The composition root: the one place that reads the settings and creates
// the real resources. Everything below it takes them as parameters.
const config = loadConfig();
const pool = createPool(config.databaseUrl);

const server = createServer(createApp({ pool, allowedOrigin: config.allowedOrigin }));
server.listen(config.port, () => console.log(`api listening on ${config.port}`));

// lo1 sends SIGTERM on `lo1 down` and `lo1 restart`; finish in-flight requests first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
}
