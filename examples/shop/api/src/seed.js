import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createProductRepository } from "./products/repository.js";
import { seedProducts } from "./products/seed-data.js";

// Run by lo1 as the `seed` init task. It replaces the data every time, so
// `lo1 restart seed` puts the products back how they started.
const pool = createPool(loadConfig().databaseUrl);
try {
  await createProductRepository(pool).replaceAll(seedProducts);
  console.log(`seeded ${seedProducts.length} products`);
} finally {
  await pool.end();
}
