/**
 * Reads the API's settings from the environment, once. The rest of the code
 * is given these values and never reads `process.env` itself.
 */
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 4100),
    databaseUrl: required(env, "DATABASE_URL"),
    // lo1 gives every service each other service's URLs. The web app's public
    // URL is the only origin allowed to call this API from a browser.
    allowedOrigin: env.LO1_SERVICE_WEB_PROXY_URL ?? "http://localhost:4200",
  };
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
