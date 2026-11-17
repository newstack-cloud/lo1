import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrations } from "../src/migrations/index.js";
import { runMigrations } from "../src/migrations/run.js";
import { useTestDatabase } from "./support/database.js";

const pool = useTestDatabase();

describe("runMigrations", () => {
  it("creates the schema and records each migration", async () => {
    const applied = await runMigrations(pool(), migrations);

    assert.deepEqual(applied, ["001-create-products"]);
    const { rows } = await pool().query("SELECT name FROM schema_migrations");
    assert.deepEqual(rows, [{ name: "001-create-products" }]);
    await pool().query("SELECT id, name, price_pence FROM products");
  });

  it("applies nothing the second time", async () => {
    const applied = await runMigrations(pool(), migrations);

    assert.deepEqual(applied, []);
  });

  it("rolls back a migration that fails, so it runs again next time", async () => {
    const broken = { name: "002-broken", up: (db) => db.query("ALTER TABLE missing ADD x INT") };

    await assert.rejects(runMigrations(pool(), [...migrations, broken]), /missing/);

    const { rows } = await pool().query("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(rows, [{ name: "001-create-products" }]);
  });
});
