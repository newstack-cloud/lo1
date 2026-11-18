import pg from "pg";

// One pool per process. In dev mode Next.js reloads modules often, so the pool
// is kept on `globalThis` to avoid opening a new one on every reload.
export const pool = (globalThis.pgPool ??= new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
}));
