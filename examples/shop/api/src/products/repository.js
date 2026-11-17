import { withTransaction } from "../transaction.js";

/**
 * Reads and writes products in Postgres. The routes and the seed script use
 * these methods, so they never need to know about SQL or column names.
 */
export function createProductRepository(pool) {
  return {
    async list() {
      const { rows } = await pool.query("SELECT id, name, price_pence FROM products ORDER BY id");
      return rows.map(toProduct);
    },

    /** Replaces every product in one transaction, so nobody sees a half-written table. */
    async replaceAll(products) {
      await withTransaction(pool, async (client) => {
        await client.query("TRUNCATE products RESTART IDENTITY");
        for (const product of products) {
          await client.query("INSERT INTO products (name, price_pence) VALUES ($1, $2)", [
            product.name,
            product.pricePence,
          ]);
        }
      });
    },
  };
}

function toProduct(row) {
  return { id: row.id, name: row.name, pricePence: row.price_pence };
}
