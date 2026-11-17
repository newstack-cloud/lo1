import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createApp } from "../src/app.js";
import { createProductRepository } from "../src/products/repository.js";
import { seedProducts } from "../src/products/seed-data.js";
import { useTestDatabase } from "./support/database.js";
import { useServer } from "./support/http.js";

const pool = useTestDatabase({ migrated: true });
const request = useServer(() =>
  createApp({ pool: pool(), allowedOrigin: "https://web.shop.local", onError: () => {} }),
);

describe("the API, against Postgres", () => {
  it("serves the seeded products to the web app's origin", async () => {
    await createProductRepository(pool()).replaceAll(seedProducts);

    const res = await request("/products");

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://web.shop.local");
    const products = await res.json();
    assert.deepEqual(
      products.map(({ name, pricePence }) => ({ name, pricePence })),
      seedProducts,
    );
  });

  it("is healthy while the database answers", async () => {
    const res = await request("/health");

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("the API's health check without a database", () => {
  // Nothing listens on port 1, so every query fails.
  const unreachable = new pg.Pool({
    connectionString: "postgres://shop:shop@127.0.0.1:1/shop",
    connectionTimeoutMillis: 500,
  });
  const requestUnhealthy = useServer(() =>
    createApp({ pool: unreachable, allowedOrigin: "https://web.shop.local", onError: () => {} }),
  );

  it("fails, so lo1's readiness probe keeps waiting", async () => {
    const res = await requestUnhealthy("/health");

    assert.equal(res.status, 500);
    await unreachable.end();
  });
});
