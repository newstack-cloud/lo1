import pg from "pg";

const notes = ["Hello from Postgres", "Served by Next.js", "Started by lo1"];

// Run by lo1 as the `seed` init task. It replaces the data every time, so
// `lo1 restart seed` puts the notes back how they started.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query("TRUNCATE notes RESTART IDENTITY");
  for (const body of notes) {
    await pool.query("INSERT INTO notes (body) VALUES ($1)", [body]);
  }
  console.log(`seeded ${notes.length} notes`);
} finally {
  await pool.end();
}
