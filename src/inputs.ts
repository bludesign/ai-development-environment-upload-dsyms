import * as core from "@actions/core";

import { parseHeaders } from "./headers.js";

export const MIB = 1024 * 1024;

export type NoFilesBehavior = "error" | "warn" | "ignore";

export type UploadMetadata = {
  projectName: string | null;
  buildId: string | null;
  url: string | null;
};

export type Inputs = {
  /** The control plane's origin, such as `https://aide.example.com`; null only in a dry run. */
  origin: string | null;
  apiKey: string | null;
  /** Newline-separated patterns for `@actions/glob`. */
  patterns: string;
  headers: Record<string, string>;
  metadata: UploadMetadata;
  chunkBytes: number;
  retries: number;
  timeoutMs: number;
  ifNoFilesFound: NoFilesBehavior;
  dryRun: boolean;
};

/** Masking a very short value would garble every log line that contains it. */
const MIN_MASKED_LENGTH = 4;

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * Validates `url`: an http(s) origin with no path, query, or credentials. The
 * control plane serves its API and dashboard from the root, and the paths it
 * returns are root-relative.
 */
export function parseOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      `url must be an absolute URL such as https://aide.example.com, not "${value}"`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("url must start with https:// or http://");
  }
  if (url.username || url.password) {
    throw new Error(
      "url must not contain credentials; pass the API key in api_key",
    );
  }
  if (url.search || url.hash) {
    throw new Error("url must not contain a query or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path) {
    const hint = /(^|\/)api(\/|$)/.test(path)
      ? " Leave out /api; the action adds the endpoint paths itself."
      : "";
    throw new Error(
      `url must be the control plane's origin, such as ${url.origin}, without a path.${hint}`,
    );
  }
  return url;
}

function integerInput(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = core.getInput(name).trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be a whole number from ${minimum} to ${maximum}, not "${raw}"`,
    );
  }
  return value;
}

/** `core.getBooleanInput` throws when an input is empty, as it is outside a runner. */
function booleanInput(name: string): boolean {
  const raw = core.getInput(name).trim();
  if (!raw) return false;
  if (/^(true|yes|on)$/i.test(raw)) return true;
  if (/^(false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false, not "${raw}"`);
}

/** Mirrors the server's metadata rules: trimmed, empty means omitted, and a length limit. */
function textInput(name: string, maximum: number): string | null {
  const value = core.getInput(name).trim();
  if (!value) return null;
  if (value.length > maximum) {
    throw new Error(`${name} must be at most ${maximum} characters`);
  }
  return value;
}

function linkInput(name: string): string | null {
  const value = textInput(name, 2_000);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL, not "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use http or https`);
  }
  return value;
}

function ifNoFilesFoundInput(): NoFilesBehavior {
  const value = core.getInput("if_no_files_found").trim().toLowerCase();
  if (!value) return "error";
  if (value === "error" || value === "warn" || value === "ignore") return value;
  throw new Error(
    `if_no_files_found must be error, warn, or ignore, not "${value}"`,
  );
}

function mask(value: string) {
  // Outside a runner, setSecret only echoes the value to stdout.
  if (process.env.GITHUB_ACTIONS !== "true") return;
  if (value.length >= MIN_MASKED_LENGTH) core.setSecret(value);
}

export function readInputs(): Inputs {
  const dryRun = booleanInput("dry_run");
  const apiKey = core.getInput("api_key", { required: !dryRun }).trim() || null;
  if (apiKey) mask(apiKey);
  const headers = parseHeaders(core.getInput("headers"));
  for (const value of Object.values(headers)) mask(value);

  const rawUrl = core.getInput("url", { required: !dryRun }).trim();
  let origin: string | null = null;
  if (rawUrl) {
    const url = parseOrigin(rawUrl);
    if (url.protocol === "http:" && !isLoopback(url.hostname)) {
      core.warning(
        `url uses http://, so the API key and dSYMs travel unencrypted to ${url.host}`,
      );
    }
    origin = url.origin;
  }

  const patterns = core.getInput("dsym_paths", { required: true });
  if (!patterns.split(/\r?\n/).some((line) => line.trim())) {
    throw new Error("Input required and not supplied: dsym_paths");
  }

  return {
    origin,
    apiKey,
    patterns,
    headers,
    metadata: {
      projectName: textInput("project_name", 200),
      buildId: textInput("build_id", 200),
      url: linkInput("build_url"),
    },
    chunkBytes: integerInput("chunk_size", 16, 1, 16) * MIB,
    retries: integerInput("retries", 5, 0, 10),
    timeoutMs: integerInput("timeout", 120, 10, 600) * 1000,
    ifNoFilesFound: ifNoFilesFoundInput(),
    dryRun,
  };
}
