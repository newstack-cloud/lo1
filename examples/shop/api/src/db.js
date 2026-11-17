import pg from "pg";

/** A connection pool for Postgres. Everything else takes the pool as a parameter. */
export function createPool(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}
