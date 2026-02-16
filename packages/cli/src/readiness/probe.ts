import { Lo1Error } from "../errors";
import { createLog } from "../debug";

const debug = createLog("readiness");

export class ReadinessProbeError extends Lo1Error {
  constructor(service: string, url: string, reason: string) {
    super(`Readiness probe failed for "${service}": ${reason} (${url})`, "ReadinessProbeError", {
      service,
      url,
    });
    this.name = "ReadinessProbeError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_BACKOFF_MULTIPLIER = 1.5;
const DEFAULT_MAX_INTERVAL_MS = 5_000;

export type ProbeOptions = {
  url: string;
  serviceName: string;
  timeoutMs?: number;
  intervalMs?: number;
  backoffMultiplier?: number;
  maxIntervalMs?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, status?: number) => void;
};

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export async function waitForReady(
  options: ProbeOptions,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initialInterval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const backoff = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const maxInterval = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;

  const start = Date.now();
  let attempt = 0;
  let interval = initialInterval;

  debug("probing %s for %s (timeout %dms)", options.url, options.serviceName, timeoutMs);

  while (true) {
    if (options.signal?.aborted) {
      throw new ReadinessProbeError(options.serviceName, options.url, "aborted");
    }

    attempt++;
    options.onAttempt?.(attempt);

    try {
      const fetchController = new AbortController();
      const fetchTimeout = setTimeout(() => fetchController.abort(), 5_000);
      const response = await fetchFn(options.url, { signal: fetchController.signal });
      clearTimeout(fetchTimeout);

      debug("probe %s attempt %d → %d", options.url, attempt, response.status);

      if (response.status >= 200 && response.status < 300) {
        return;
      }
    } catch (err) {
      debug("probe %s attempt %d → error: %s", options.url, attempt, (err as Error).message);
    }

    if (Date.now() - start >= timeoutMs) {
      throw new ReadinessProbeError(
        options.serviceName,
        options.url,
        `timed out after ${timeoutMs}ms (${attempt} attempts)`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * backoff, maxInterval);
  }
}
