import { withTransaction } from "../transaction.js";

/**
 * Applies the migrations that haven't run yet, each in its own transaction,
 * and records them in `schema_migrations` so they never run twice.
 * Returns the names of the migrations it applied.
 */
export async function runMigrations(pool, migrations) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((row) => row.name));

  const applied = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    await withTransaction(pool, async (client) => {
      await migration.up(client);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
    });
    applied.push(migration.name);
  }
  return applied;
}
