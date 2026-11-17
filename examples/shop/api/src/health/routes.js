/**
 * `GET /health`, which lo1's readiness probe calls. It only reports healthy
 * when the database answers, so lo1 waits for a working API, not just a
 * listening one.
 */
export function healthRoutes(checkDatabase) {
  return [
    {
      method: "GET",
      path: "/health",
      handle: async () => {
        await checkDatabase();
        return { body: { ok: true } };
      },
    },
  ];
}
