import { createServer } from "node:http";
import { connect } from "./db.js";

const db = connect();
await db.connect();

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    // The web app is served from its own domain, so allow it to call the API.
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true });
  if (req.url === "/products") {
    const { rows } = await db.query("SELECT id, name, price_pence FROM products ORDER BY id");
    return send(res, 200, rows);
  }
  send(res, 404, { error: "not found" });
});

const port = Number(process.env.PORT ?? 4100);
server.listen(port, () => console.log(`api listening on ${port}`));

process.on("SIGTERM", () => server.close(() => db.end().then(() => process.exit(0))));
