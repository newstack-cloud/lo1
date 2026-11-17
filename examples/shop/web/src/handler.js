import { readFile } from "node:fs/promises";

const PUBLIC_DIR = new URL("../public/", import.meta.url);

/** The files the page needs. Only these are served, so no path can reach anything else. */
const PUBLIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

/** Reads the public files into memory once, at startup. */
export async function loadPublicFiles(dir = PUBLIC_DIR) {
  const entries = await Promise.all(
    Object.entries(PUBLIC_FILES).map(async ([path, { file, type }]) => [
      path,
      { type, body: await readFile(new URL(file, dir)) },
    ]),
  );
  return new Map(entries);
}

/**
 * Builds the web app's request handler. It serves the public files, plus
 * `/config.json`, which tells the page where the API is.
 */
export function createWebHandler({ files, apiUrl }) {
  const config = Buffer.from(JSON.stringify({ apiUrl }));
  const headers = securityHeaders(apiUrl);

  return (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed", headers);
    if (pathname === "/config.json") return send(res, 200, "application/json", config, headers);

    const page = files.get(pathname);
    if (!page) return send(res, 404, "text/plain", "not found", headers);
    send(res, 200, page.type, page.body, headers);
  };
}

/** Lets the page load only its own files and call only the API. */
function securityHeaders(apiUrl) {
  return {
    "content-security-policy": `default-src 'self'; connect-src 'self' ${new URL(apiUrl).origin}`,
    "x-content-type-options": "nosniff",
  };
}

function send(res, status, type, body, headers) {
  res.writeHead(status, { ...headers, "content-type": type });
  res.end(body);
}
