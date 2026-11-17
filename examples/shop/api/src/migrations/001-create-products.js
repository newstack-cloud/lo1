export const name = "001-create-products";

export async function up(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price_pence INTEGER NOT NULL CHECK (price_pence >= 0)
    )
  `);
}
