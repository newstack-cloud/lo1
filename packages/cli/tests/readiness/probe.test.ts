import { describe, it, expect, mock } from "bun:test";
import { waitForReady, ReadinessProbeError, type FetchFn } from "../../src/readiness/probe";

function mockFetch(responses: Array<Response | Error>): FetchFn {
  let i = 0;
  return mock(async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as FetchFn;
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}

function status(code: number): Response {
  return new Response("", { status: code });
}

describe("waitForReady", () => {
  it("succeeds immediately when fetch returns 200", async () => {
    const fetch = mockFetch([ok()]);

    await waitForReady(
      { url: "http://localhost:3000/health", serviceName: "api" },
      fetch,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("succeeds on second attempt after first returns 503", async () => {
    const fetch = mockFetch([status(503), ok()]);

    await waitForReady(
      {
        url: "http://localhost:3000/health",
        serviceName: "api",
        timeoutMs: 5000,
        intervalMs: 10,
      },
      fetch,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("succeeds on second attempt after first throws (network error)", async () => {
    const fetch = mockFetch([new Error("ECONNREFUSED"), ok()]);

    await waitForReady(
      {
        url: "http://localhost:3000/health",
        serviceName: "api",
        timeoutMs: 5000,
        intervalMs: 10,
      },
      fetch,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws ReadinessProbeError on timeout", async () => {
    const fetch = mockFetch([new Error("ECONNREFUSED")]);

    await expect(
      waitForReady(
        {
          url: "http://localhost:3000/health",
          serviceName: "api",
          timeoutMs: 100,
          intervalMs: 20,
        },
        fetch,
      ),
    ).rejects.toThrow(ReadinessProbeError);
  });

  it("throws ReadinessProbeError when abort signal fires", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetch = mockFetch([ok()]);

    await expect(
      waitForReady(
        {
          url: "http://localhost:3000/health",
          serviceName: "api",
          signal: controller.signal,
        },
        fetch,
      ),
    ).rejects.toThrow(ReadinessProbeError);
  });

  it("non-2xx responses (400, 500) trigger retry", async () => {
    const fetch = mockFetch([status(400), status(500), ok()]);

    await waitForReady(
      {
        url: "http://localhost:3000/health",
        serviceName: "api",
        timeoutMs: 5000,
        intervalMs: 10,
      },
      fetch,
    );

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("calls onAttempt callback with attempt number", async () => {
    const attempts: number[] = [];
    const fetch = mockFetch([new Error("ECONNREFUSED"), ok()]);

    await waitForReady(
      {
        url: "http://localhost:3000/health",
        serviceName: "api",
        timeoutMs: 5000,
        intervalMs: 10,
        onAttempt: (attempt) => attempts.push(attempt),
      },
      fetch,
    );

    expect(attempts).toEqual([1, 2]);
  });
});
