import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  startMockServer,
  type Fault,
  type MockServer,
} from "../test/mock-server.js";
import {
  CancelledError,
  Client,
  HttpError,
  USER_AGENT,
  isRetryableStatus,
  parseRetryAfter,
} from "./http.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  info: vi.fn(),
}));

let server: MockServer;
let fault: ((path: string, method: string) => Fault | undefined) | undefined;
const sleeps: number[] = [];

beforeEach(async () => {
  fault = undefined;
  sleeps.length = 0;
  server = await startMockServer({
    fault: (request) => fault?.(request.path, request.method),
  });
});

afterEach(async () => {
  await server.close();
});

function client(
  options: Partial<ConstructorParameters<typeof Client>[0]> = {},
) {
  return new Client({
    origin: server.url,
    apiKey: "aide_test",
    headers: { "CF-Access-Client-Id": "id.access" },
    timeoutMs: 2_000,
    retries: 2,
    signal: new AbortController().signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...options,
  });
}

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  return promise.then(
    () => {
      throw new Error("Expected the request to fail");
    },
    (error: unknown) => error as HttpError,
  );
}

const start = {
  method: "POST",
  path: "/api/dsyms/uploads",
  json: { filename: "a.zip", sizeBytes: 1 },
} as const;

describe("Client.send", () => {
  test("sends the key, the extra headers, and a user agent", async () => {
    await client().json(start);
    expect(server.requests[0]!.headers).toMatchObject({
      "x-api-key": "aide_test",
      "cf-access-client-id": "id.access",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    });
  });

  test("surfaces the control plane's JSON error", async () => {
    const error = await rejection(client({ apiKey: "aide_wrong" }).json(start));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      retryable: false,
    });
    expect(error.message).toBe(
      "POST /api/dsyms/uploads returned 401: The API key is invalid or inactive (AUTHENTICATION_REQUIRED)",
    );
  });

  test("does not follow a redirect to Cloudflare Access", async () => {
    fault = () => ({
      status: 302,
      headers: {
        location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/aide",
      },
    });
    const error = await rejection(client().json(start));
    expect(error.message).toContain("returned 302");
    expect(error.message).toContain("Cloudflare Access stopped the request");
    expect(server.requests).toHaveLength(1);
  });

  test("does not follow other redirects either", async () => {
    fault = () => ({
      status: 301,
      headers: { location: "https://elsewhere.example.com/" },
    });
    const error = await rejection(client().json(start));
    expect(error.message).toContain(
      "redirected to https://elsewhere.example.com/",
    );
  });

  test("explains a Cloudflare challenge and does not retry it", async () => {
    fault = () => ({
      status: 403,
      headers: {
        "cf-mitigated": "challenge",
        "cf-ray": "8a1b2c3d4e5f",
        "content-type": "text/html",
      },
      body: "<html>Just a moment...</html>",
    });
    const error = await rejection(
      client().withRetry("Start", () => client().json(start)),
    );
    expect(error).toMatchObject({ status: 403, retryable: false });
    expect(error.message).toContain("challenge");
    expect(server.requests).toHaveLength(1);
  });

  test("explains a Cloudflare block and an Access 401", async () => {
    fault = () => ({
      status: 403,
      headers: { "cf-ray": "8a1b2c3d4e5f" },
      body: "blocked",
    });
    expect((await rejection(client().json(start))).message).toContain(
      "Ray ID 8a1b2c3d4e5f",
    );
    fault = () => ({
      status: 401,
      headers: { server: "cloudflare" },
      body: "Unauthorized",
    });
    expect((await rejection(client().json(start))).message).toContain(
      "CF-Access-Client-Id",
    );
  });

  test("names Cloudflare's own 52x errors and suggests chunk_size for a proxy 413", async () => {
    fault = () => ({ status: 524, headers: { "cf-ray": "1" } });
    expect((await rejection(client().json(start))).message).toContain(
      "Cloudflare timed out waiting for the control plane",
    );
    fault = () => ({
      status: 413,
      headers: { "content-type": "text/html" },
      body: "<h1>413</h1>",
    });
    expect((await rejection(client().json(start))).message).toContain(
      "Lower chunk_size",
    );
  });

  test("points at url when the server has no upload endpoint", async () => {
    fault = () => ({
      status: 404,
      headers: { "content-type": "text/html" },
      body: "Not found",
    });
    expect((await rejection(client().json(start))).message).toContain(
      "no dSYM upload endpoint",
    );
  });

  test("rejects a success that is not JSON", async () => {
    fault = () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html>Sign in</html>",
    });
    expect((await rejection(client().json(start))).message).toContain(
      "body that is not JSON",
    );
  });

  test("times out", async () => {
    fault = () => ({ status: 200, delayMs: 1_000 });
    const error = await rejection(client({ timeoutMs: 100 }).json(start));
    expect(error).toMatchObject({ timedOut: true, retryable: true });
  });

  test("reports a dropped connection as retryable", async () => {
    fault = () => ({ destroy: true });
    expect(await rejection(client().json(start))).toMatchObject({
      retryable: true,
      status: null,
    });
  });

  test("stops with a cancellation error when the signal aborts", async () => {
    const controller = new AbortController();
    fault = () => ({ status: 200, delayMs: 1_000 });
    const pending = client({ signal: controller.signal }).json(start);
    setTimeout(() => controller.abort(new CancelledError("stop")), 50);
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("Client.withRetry", () => {
  test("retries transient failures with backoff", async () => {
    let failures = 2;
    fault = () => (failures-- > 0 ? { status: 502 } : undefined);
    await client().withRetry("Start", () => client().json(start));
    expect(server.requests).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  test("honors Retry-After", async () => {
    let failures = 1;
    fault = () =>
      failures-- > 0
        ? { status: 429, headers: { "retry-after": "7" } }
        : undefined;
    await client().withRetry("Start", () => client().json(start));
    expect(sleeps).toEqual([7_000]);
  });

  test("gives up after the retry budget", async () => {
    fault = () => ({ status: 503 });
    await expect(
      client().withRetry("Start", () => client().json(start)),
    ).rejects.toThrow("returned 503");
    expect(server.requests).toHaveLength(3);
  });
});

describe("helpers", () => {
  test.each([408, 425, 429, 500, 502, 503, 504, 520, 524, 530])(
    "%i is retryable",
    (status) => {
      expect(isRetryableStatus(status)).toBe(true);
    },
  );

  test.each([400, 401, 403, 404, 409, 413, 422, 501, 505])(
    "%i is not retryable",
    (status) => {
      expect(isRetryableStatus(status)).toBe(false);
    },
  );

  test("parses Retry-After seconds and dates, capped at two minutes", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(parseRetryAfter("7", now)).toBe(7_000);
    expect(parseRetryAfter("Thu, 24 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("3600", now)).toBe(120_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  test("backs off exponentially with jitter and a cap", () => {
    const low = client({ random: () => 0 });
    const high = client({ random: () => 1 });
    expect(
      [1, 2, 3, 4, 5, 6].map((attempt) => client().backoff(attempt)),
    ).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(low.backoff(1)).toBe(1_500);
    expect(high.backoff(1)).toBe(2_500);
  });
});
