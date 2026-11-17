import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createWebHandler, loadPublicFiles } from "./handler.js";

// The composition root: reads the settings and files, then starts serving.
const config = loadConfig();
const handler = createWebHandler({ files: await loadPublicFiles(), apiUrl: config.apiUrl });

const server = createServer(handler);
server.listen(config.port, () =>
  console.log(`web listening on ${config.port}, using API at ${config.apiUrl}`),
);

// lo1 sends SIGTERM on `lo1 down` and `lo1 restart`; finish in-flight requests first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
