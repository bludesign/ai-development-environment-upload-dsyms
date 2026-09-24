import { setTimeout as delay } from "node:timers/promises";

import * as core from "@actions/core";

import { errorMessage, formatDuration } from "./format.js";

declare const __VERSION__: string | undefined;

export const USER_AGENT = `ai-development-environment-upload-dsyms/${
  typeof __VERSION__ === "string" ? __VERSION__ : "dev"
}`;

/** Longest `Retry-After` the action waits for. */
const MAX_RETRY_AFTER_MS = 120_000;

const ACCESS_HINT =
  "Cloudflare Access stopped the request. Add the service token's CF-Access-Client-Id and CF-Access-Client-Secret in headers, and give the Access application a Service Auth policy for that token, or bypass Access for /api/dsyms and /api/dsyms/uploads/*";
const CHALLENGE_HINT =
  "Cloudflare answered with a challenge from bot protection or a WAF rule, which CI cannot pass. Add a WAF skip rule for /api/dsyms*, or authenticate the runner with a Cloudflare Access service token";

const CLOUDFLARE_REASONS: Record<number, string> = {
  520: "Cloudflare received an unknown error from the control plane",
  521: "the control plane refused Cloudflare's connection",
  522: "Cloudflare timed out connecting to the control plane",
  523: "Cloudflare could not reach the control plane",
  524: "Cloudflare timed out waiting for the control plane to answer",
  525: "the TLS handshake between Cloudflare and the control plane failed",
  526: "Cloudflare could not verify the control plane's certificate",
  530: "Cloudflare could not resolve the control plane",
};

export type HttpErrorDetails = {
  status: number | null;
  code: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
  timedOut: boolean;
};

export class HttpError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly timedOut: boolean;

  constructor(message: string, details: Partial<HttpErrorDetails> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.timedOut = details.timedOut ?? false;
  }
}

export class CancelledError extends Error {
  constructor(message = "The upload was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export type RequestOptions = {
  method: "HEAD" | "POST" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  json?: unknown;
  /** Replaces the cancellation signal and timeout, for cleanup after cancelling. */
  signal?: AbortSignal;
};

export type ClientOptions = {
  origin: string;
  apiKey: string;
  headers: Record<string, string>;
  timeoutMs: number;
  retries: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

export function isRetryableStatus(status: number): boolean {
  if ([408, 425, 429].includes(status)) return true;
  return status >= 500 && status <= 599 && status !== 501 && status !== 505;
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

function isAccessLogin(location: string): boolean {
  try {
    const url = new URL(location, "https://placeholder.invalid");
    return (
      url.hostname.endsWith(".cloudflareaccess.com") ||
      url.pathname.startsWith("/cdn-cgi/access/")
    );
  } catch {
    return false;
  }
}

/** The control plane's `{ error: { code, message } }` body, when that is what came back. */
function serverError(
  contentType: string | null,
  text: string,
): { code: string | null; message: string | null } {
  if (!/json/i.test(contentType ?? "")) return { code: null, message: null };
  try {
    const body = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown } | string;
    };
    if (typeof body.error === "string") {
      return { code: null, message: body.error };
    }
    return {
      code: typeof body.error?.code === "string" ? body.error.code : null,
      message:
        typeof body.error?.message === "string" ? body.error.message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

function describeFailure(
  request: RequestOptions,
  response: Response,
  text: string,
): HttpError {
  const { status, headers } = response;
  const ray = headers.get("cf-ray");
  const cloudflare =
    Boolean(ray) || /cloudflare/i.test(headers.get("server") ?? "");
  const challenge = /challenge/i.test(headers.get("cf-mitigated") ?? "");
  const { code, message } = serverError(headers.get("content-type"), text);

  let hint: string | null = null;
  if (status >= 300 && status < 400) {
    const location = headers.get("location");
    hint =
      location && isAccessLogin(location)
        ? ACCESS_HINT
        : `The server redirected to ${location ?? "another address"}. Set url to the origin the control plane answers on; redirects are not followed, so the API key is never sent elsewhere`;
  } else if (challenge) {
    hint = CHALLENGE_HINT;
  } else if (!message && status === 401) {
    // The control plane's own 401s are JSON.
    hint = cloudflare
      ? ACCESS_HINT
      : "The response did not come from the control plane; check url and any proxy in front of it";
  } else if (!message && status === 403 && cloudflare) {
    hint = `Cloudflare blocked the request with a WAF rule, IP access rule, or Access policy${ray ? ` (Ray ID ${ray})` : ""}`;
  } else if (!message && status === 413) {
    hint =
      "A proxy in front of the control plane refused the request body as too large. Lower chunk_size";
  } else if (
    !message &&
    status === 404 &&
    request.method === "POST" &&
    request.path === "/api/dsyms/uploads"
  ) {
    hint =
      "Check url: this server has no dSYM upload endpoint, or runs a version of AI Development Environment from before dSYM uploads";
  }

  const reason = message
    ? `${message.replace(/\.$/, "")}${code ? ` (${code})` : ""}`
    : (CLOUDFLARE_REASONS[status] ??
      `HTTP ${status}${response.statusText ? ` ${response.statusText}` : ""}`);
  return new HttpError(
    `${request.method} ${request.path} returned ${status}: ${reason}${hint ? `. ${hint}.` : ""}`,
    {
      status,
      code,
      retryable: !challenge && isRetryableStatus(status),
      retryAfterMs: parseRetryAfter(headers.get("retry-after")),
    },
  );
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** Sends requests to the control plane with the API key and extra headers. */
export class Client {
  readonly retries: number;
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(options: ClientOptions) {
    this.origin = options.origin.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries;
    this.signal = options.signal;
    this.sleep =
      options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.random = options.random ?? Math.random;
  }

  private cancelled(): Error {
    const reason: unknown = this.signal.reason;
    return reason instanceof Error ? reason : new CancelledError();
  }

  /** One attempt. Resolves with a 2xx response and throws an `HttpError` otherwise. */
  async send(request: RequestOptions): Promise<Response> {
    if (this.signal.aborted && !request.signal) throw this.cancelled();
    const headers = new Headers({ "user-agent": USER_AGENT });
    for (const [name, value] of Object.entries(this.headers)) {
      headers.set(name, value);
    }
    headers.set("x-api-key", this.apiKey);
    let body: Uint8Array | string | undefined = request.body;
    if (request.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(request.json);
    }
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      headers.set(name, value);
    }
    const signal =
      request.signal ??
      AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]);

    let response: Response;
    try {
      response = await fetch(`${this.origin}${request.path}`, {
        method: request.method,
        headers,
        body: body as BodyInit | undefined,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw this.networkError(request, error);
    }
    if (response.ok) return response;
    const text =
      request.method === "HEAD" ? "" : await response.text().catch(() => "");
    throw describeFailure(request, response, text);
  }

  /** Sends a request and parses its JSON body. */
  async json<T>(request: RequestOptions): Promise<T> {
    const response = await this.send(request);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(
        `${request.method} ${request.path} returned ${response.status} with a body that is not JSON (${response.headers.get("content-type") ?? "no content type"}). A proxy or sign-in page may be answering instead of the control plane.`,
        { status: response.status },
      );
    }
  }

  private networkError(request: RequestOptions, error: unknown): Error {
    if (this.signal.aborted && !request.signal) return this.cancelled();
    const label = `${request.method} ${request.path}`;
    if (isTimeout(error)) {
      return new HttpError(
        `${label} timed out after ${formatDuration(this.timeoutMs)}`,
        { retryable: true, timedOut: true },
      );
    }
    const cause = (error as { cause?: { code?: unknown; message?: unknown } })
      .cause;
    const code = typeof cause?.code === "string" ? cause.code : "";
    const detail =
      typeof cause?.message === "string" ? cause.message : errorMessage(error);
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
      return new HttpError(
        `${label} failed: ${detail}. If the control plane uses a private certificate authority, set NODE_EXTRA_CA_CERTS to its certificate in the step's env.`,
      );
    }
    return new HttpError(`${label} failed: ${detail}`, { retryable: true });
  }

  /** Delay before retry `attempt` (from 1): exponential with jitter. */
  backoff(attempt: number): number {
    const base = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
    return Math.round(base * (0.75 + this.random() * 0.5));
  }

  /** Sleeps, ending early with a cancellation error. */
  async wait(ms: number): Promise<void> {
    try {
      await this.sleep(ms, this.signal);
    } catch (error) {
      if (this.signal.aborted) throw this.cancelled();
      throw error;
    }
    if (this.signal.aborted) throw this.cancelled();
  }

  /** Waits before retry `attempt`, honoring `Retry-After`. */
  async pause(attempt: number, error: HttpError, label: string): Promise<void> {
    const wait = error.retryAfterMs ?? this.backoff(attempt);
    core.info(
      `${label}: ${error.message.replace(/\.?$/, ".")} Retrying in ${formatDuration(wait)} (${attempt} of ${this.retries}).`,
    );
    await this.wait(wait);
  }

  /** Runs `attempt`, retrying retryable failures up to `retries` times. */
  async withRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
    for (let failures = 0; ; failures += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          !error.retryable ||
          failures >= this.retries
        ) {
          throw error;
        }
        await this.pause(failures + 1, error, label);
      }
    }
  }
}
