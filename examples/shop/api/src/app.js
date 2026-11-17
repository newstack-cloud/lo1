import { createRouter } from "./http/router.js";
import { healthRoutes } from "./health/routes.js";
import { createProductRepository } from "./products/repository.js";
import { productRoutes } from "./products/routes.js";

/**
 * Wires the API together: repositories on top of the pool, routes on top of
 * the repositories. Returns a Node request handler. The pool and settings
 * come from the caller, so tests can run the real API on a test database.
 */
export function createApp({ pool, allowedOrigin, onError }) {
  const products = createProductRepository(pool);

  return createRouter(
    [...healthRoutes(() => pool.query("SELECT 1")), ...productRoutes(products)],
    {
      headers: { "access-control-allow-origin": allowedOrigin, vary: "Origin" },
      onError,
    },
  );
}
