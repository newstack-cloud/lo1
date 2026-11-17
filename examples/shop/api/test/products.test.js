import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProductRepository } from "../src/products/repository.js";
import { useTestDatabase } from "./support/database.js";

const pool = useTestDatabase({ migrated: true });

describe("createProductRepository", () => {
  it("lists the products it stored, in order", async () => {
    const products = createProductRepository(pool());

    await products.replaceAll([
      { name: "Loopback mug", pricePence: 1200 },
      { name: "IPv6 sticker pack", pricePence: 400 },
    ]);

    assert.deepEqual(await products.list(), [
      { id: 1, name: "Loopback mug", pricePence: 1200 },
      { id: 2, name: "IPv6 sticker pack", pricePence: 400 },
    ]);
  });

  it("replaces everything, restarting the ids", async () => {
    const products = createProductRepository(pool());

    await products.replaceAll([{ name: "127.0.0.1 hoodie", pricePence: 3800 }]);

    assert.deepEqual(await products.list(), [{ id: 1, name: "127.0.0.1 hoodie", pricePence: 3800 }]);
  });

  it("keeps the previous products when a replacement is rejected", async () => {
    const products = createProductRepository(pool());
    const before = await products.list();

    // The schema rejects negative prices; the whole replacement is rolled back.
    await assert.rejects(
      products.replaceAll([
        { name: "Fine", pricePence: 100 },
        { name: "Broken", pricePence: -1 },
      ]),
      /price_pence/,
    );

    assert.deepEqual(await products.list(), before);
  });
});
