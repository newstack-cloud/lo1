import pg from "pg";

// Run by lo1 as the `migrate` init task, before `seed` and the web app start.
// It is safe to run more than once.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      body TEXT NOT NULL
    )
  `);
  console.log("migrations applied");
} finally {
  await pool.end();
}
