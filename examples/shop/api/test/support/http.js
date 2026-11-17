import { createServer } from "node:http";
import { after, before } from "node:test";

/**
 * Serves `createHandler()` on a free local port for the duration of a test
 * file. Returns a function that fetches a path from it.
 *
 * The handler is built on the first request rather than in `before`: hooks
 * at the top of a file don't wait for each other, and the handler usually
 * needs the test database, which another hook sets up.
 */
export function useServer(createHandler) {
  let server;
  let baseUrl;
  let handler;

  before(async () => {
    server = createServer((req, res) => (handler ??= createHandler())(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  return (path, init) => fetch(`${baseUrl}${path}`, init);
}
