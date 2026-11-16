import pg from "pg";

export function connect() {
  return new pg.Client({ connectionString: process.env.DATABASE_URL });
}
