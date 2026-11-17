/**
 * Builds a Node request handler from a list of routes.
 *
 * A route is `{ method, path, handle }`. `handle(req)` returns
 * `{ status?, body }` and never touches the response, so a route can be
 * tested without a server. Adding an endpoint means adding a route; the
 * router itself doesn't change.
 */
export function createRouter(routes, { headers = {}, onError = console.error } = {}) {
  const byKey = new Map(routes.map((route) => [routeKey(route.method, route.path), route]));

  return async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const route = byKey.get(routeKey(req.method, pathname));
    if (!route) return sendJson(res, 404, { error: "not found" }, headers);

    try {
      const { status = 200, body } = await route.handle(req);
      sendJson(res, status, body, headers);
    } catch (err) {
      onError(err);
      sendJson(res, 500, { error: "internal error" }, headers);
    }
  };
}

function routeKey(method, path) {
  return `${method} ${path}`;
}

function sendJson(res, status, body, headers) {
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
