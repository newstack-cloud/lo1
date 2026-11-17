import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/http/router.js";
import { useServer } from "./support/http.js";

const errors = [];
const request = useServer(() =>
  createRouter(
    [
      { method: "GET", path: "/hello", handle: async () => ({ body: { hi: true } }) },
      { method: "POST", path: "/things", handle: async () => ({ status: 201, body: { id: 1 } }) },
      { method: "GET", path: "/boom", handle: async () => Promise.reject(new Error("db down")) },
    ],
    {
      headers: { "access-control-allow-origin": "https://web.shop.local" },
      onError: (err) => errors.push(err.message),
    },
  ),
);

describe("createRouter", () => {
  it("sends a route's body as JSON with the shared headers", async () => {
    const res = await request("/hello?ignored=1");

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hi: true });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://web.shop.local");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  });

  it("uses the status a route returns", async () => {
    const res = await request("/things", { method: "POST" });

    assert.equal(res.status, 201);
  });

  it("answers 404 for an unknown path or method", async () => {
    assert.equal((await request("/nope")).status, 404);
    assert.equal((await request("/hello", { method: "DELETE" })).status, 404);
  });

  it("answers 500 without leaking the error when a route throws", async () => {
    const res = await request("/boom");

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal error" });
    assert.deepEqual(errors, ["db down"]);
  });
});
