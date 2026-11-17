/**
 * Reads the web app's settings from the environment, once.
 */
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 4200),
    // lo1 gives every service each other service's URLs. The browser has to
    // reach the API through the proxy, so it needs the API's public URL.
    apiUrl: env.LO1_SERVICE_API_PROXY_URL ?? "http://localhost:4100",
  };
}
