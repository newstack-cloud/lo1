import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// lo1 tells every service where the others are. The browser needs the API's
// public URL, through the proxy, so pass it to the page.
const apiUrl = process.env.LO1_SERVICE_API_PROXY_URL ?? "http://localhost:4100";
const page = await readFile(new URL("./index.html", import.meta.url), "utf-8");

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page.replace("__API_URL__", apiUrl));
});

const port = Number(process.env.PORT ?? 4200);
server.listen(port, () => console.log(`web listening on ${port}, using API at ${apiUrl}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
