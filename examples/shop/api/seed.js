import { connect } from "./db.js";

const products = [
  ["Loopback mug", 1200],
  ["IPv6 sticker pack", 400],
  ["127.0.0.1 hoodie", 3800],
];

const db = connect();
await db.connect();
// Start from a known state every time, so `lo1 restart seed` resets the data.
await db.query("TRUNCATE products RESTART IDENTITY");
for (const [name, pricePence] of products) {
  await db.query("INSERT INTO products (name, price_pence) VALUES ($1, $2)", [name, pricePence]);
}
await db.end();
console.log(`seeded ${products.length} products`);
