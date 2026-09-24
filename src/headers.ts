/**
 * Extra request headers, such as Cloudflare Access service-token headers. The
 * format and validation match the control agent's `--header "Name: value"`.
 */

/** Headers the action sets itself, or that the control plane reads as a credential. */
const RESERVED = new Map<string, string>([
  [
    "authorization",
    "the control plane reads it as a credential and refuses requests that also send X-API-Key",
  ],
  ["x-api-key", "pass the API key in api_key"],
  ["content-type", "the action sets it for each request"],
  ["content-length", "the action sets it for each request"],
  ["upload-offset", "the action sets it for each request"],
  ["host", "it is taken from url"],
  ["transfer-encoding", "the action sets it for each request"],
  ["connection", "the action manages connections"],
]);

export function parseHeaderLine(line: string): [string, string] {
  const separator = line.indexOf(":");
  if (separator <= 0) {
    throw new Error('Each headers line must use the format "Name: value"');
  }
  const name = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error(`Invalid HTTP header name: ${name || "(empty)"}`);
  }
  if (!value || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
    throw new Error(`Invalid value for HTTP header ${name}`);
  }
  return [name, value];
}

/**
 * Parses the `headers` input: one `Name: value` per line, blank lines ignored.
 * A name repeated in any case keeps the last value.
 */
export function parseHeaders(text: string): Record<string, string> {
  const headers = new Map<string, [string, string]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [name, value] = parseHeaderLine(line);
    const reason = RESERVED.get(name.toLowerCase());
    if (reason) {
      throw new Error(`The ${name} header cannot be set in headers: ${reason}`);
    }
    headers.set(name.toLowerCase(), [name, value]);
  }
  return Object.fromEntries(headers.values());
}
