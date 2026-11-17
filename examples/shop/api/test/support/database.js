import { randomUUID } from "node:crypto";
import { after, before } from "node:test";
import pg from "pg";
import { migrations } from "../../src/migrations/index.js";
import { runMigrations } from "../../src/migrations/run.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://shop:shop@localhost:54330/shop_test";

/**
 * Gives a test file its own empty schema in the test database, so files can
 * run in parallel without seeing each other's data. The schema is dropped
 * when the file finishes. With `{ migrated: true }` the schema starts with
 * every migration applied.
 *
 * Returns a getter for the pool, which exists once `before` has run.
 */
export function useTestDatabase({ migrated = false } = {}) {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  let pool;

  before(async () => {
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect().catch((err) => {
      throw new Error(
        `Can't reach the test database at ${DATABASE_URL} (${err.message}). ` +
          "Run the tests with npm test, which starts it.",
      );
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();

    // Every connection in this pool works inside the file's own schema.
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    if (migrated) await runMigrations(pool, migrations);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  return () => pool;
}
