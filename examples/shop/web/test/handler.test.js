import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWebHandler, loadPublicFiles } from "../src/handler.js";

let server;
let baseUrl;

before(async () => {
  const handler = createWebHandler({
    files: await loadPublicFiles(),
    apiUrl: "https://api.shop.local",
  });
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const request = (path, init) => fetch(`${baseUrl}${path}`, init);

describe("the web app", () => {
  it("serves the page and its own files", async () => {
    const page = await request("/");

    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /<ul id="products"/);
    assert.equal((await request("/app.js")).status, 200);
    assert.equal((await request("/styles.css")).status, 200);
  });

  it("tells the page where the API is", async () => {
    const res = await request("/config.json");

    assert.deepEqual(await res.json(), { apiUrl: "https://api.shop.local" });
  });

  it("only lets the page load its own files and call the API", async () => {
    const res = await request("/");

    assert.equal(
      res.headers.get("content-security-policy"),
      "default-src 'self'; connect-src 'self' https://api.shop.local",
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("serves nothing outside its public files", async () => {
    assert.equal((await request("/%2e%2e/src/config.js")).status, 404);
    assert.equal((await request("/package.json")).status, 404);
    assert.equal((await request("/", { method: "POST" })).status, 405);
  });
});
