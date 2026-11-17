import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { migrations } from "./migrations/index.js";
import { runMigrations } from "./migrations/run.js";

// Run by lo1 as the `migrate` init task, before `seed` and the API start.
const pool = createPool(loadConfig().databaseUrl);
try {
  await runMigrations(pool, migrations);
  console.log("migrations applied");
} finally {
  await pool.end();
}
