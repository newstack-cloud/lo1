/**
 * The product endpoints. They depend on a repository with a `list()` method,
 * not on Postgres, so tests can pass in a fake one.
 */
export function productRoutes(products) {
  return [
    {
      method: "GET",
      path: "/products",
      handle: async () => ({ body: await products.list() }),
    },
  ];
}
