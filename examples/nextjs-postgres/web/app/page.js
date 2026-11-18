import { pool } from "../lib/db.js";

// Read on every request, so the page reflects what is in Postgres right now.
export const dynamic = "force-dynamic";

export default async function Page() {
  // A server component: this query runs on the server, never in the browser.
  const { rows } = await pool.query("SELECT id, body FROM notes ORDER BY id");

  return (
    <main>
      <h1>Notes</h1>
      <p>Read from Postgres by a Next.js server component.</p>
      <ul>
        {rows.map((note) => (
          <li key={note.id}>{note.body}</li>
        ))}
      </ul>
    </main>
  );
}
