import { connect } from "./db.js";

const db = connect();
await db.connect();
await db.query(`
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price_pence INTEGER NOT NULL
  )
`);
await db.end();
console.log("migrations applied");
