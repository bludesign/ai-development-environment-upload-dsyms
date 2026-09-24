/**
 * A stand-in for the control plane's resumable dSYM upload endpoints, with the
 * same status codes, per-upload lock, and duplicate handling, plus hooks that
 * inject proxy failures. Vitest imports it; CI runs it directly:
 *
 *   node test/mock-server.ts --port 8787 --require-header "CF-Access-Client-Id: id" --flaky
 *
 * It runs under Node's type stripping, so it uses erasable syntax only and no
 * relative imports.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import yauzl, { type Entry } from "yauzl";

export type MockDsym = {
  id: string;
  bundleName: string;
  version: string | null;
  build: string | null;
  url: string;
  slices: { uuid: string; arch: string }[];
};

export type MockUpload = {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256: string | null;
  projectName: string | null;
  buildId: string | null;
  url: string | null;
  status: "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
  chunks: Buffer[];
  offset: number;
  dsyms: MockDsym[];
  lock: Promise<unknown>;
};

export type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes: number;
};

/**
 * How to disturb one request:
 * - `instead`: answer with the fault and do nothing else.
 * - `after`: handle the request, then answer with the fault (a lost response).
 * - `background`: start handling it and answer with the fault right away, as a
 *   proxy does when it times out while the server keeps working.
 */
export type Fault = {
  mode?: "instead" | "after" | "background";
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Close the connection without answering. */
  destroy?: boolean;
  delayMs?: number;
};

export type MockServerOptions = {
  apiKey?: string;
  /** Headers every request needs, as Cloudflare Access would enforce. */
  requiredHeaders?: Record<string, string>;
  /** How long indexing takes during `/complete`. */
  indexingMs?: number;
  fault?: (request: RecordedRequest) => Fault | undefined;
  port?: number;
};

export type MockServer = {
  url: string;
  requests: RecordedRequest[];
  uploads: Map<string, MockUpload>;
  close(): Promise<void>;
};

const CHUNK_BYTES = 16 * 1024 * 1024;
const DWARF_ENTRY =
  /^(?:(.*)\/)?([^/]+\.dSYM)\/Contents\/Resources\/DWARF\/([^/]+)$/i;

class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Reply = {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function uuidFrom(bytes: Buffer): string {
  const hex = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Reads DWARF entries the way the control plane's indexer does. */
function indexZip(zip: Buffer): Promise<MockDsym[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      zip,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, file) => {
        if (error || !file) {
          reject(new RequestError(400, "INVALID_DSYM_ARCHIVE", String(error)));
          return;
        }
        const bundles = new Map<string, MockDsym>();
        file.on("error", (entryError: Error) =>
          reject(
            new RequestError(400, "INVALID_DSYM_ARCHIVE", entryError.message),
          ),
        );
        file.on("entry", (entry: Entry) => {
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
            reject(
              new RequestError(
                400,
                "INVALID_DSYM_ARCHIVE",
                `The zip holds a symbolic link (${entry.fileName})`,
              ),
            );
            return;
          }
          const match = DWARF_ENTRY.exec(entry.fileName);
          if (!match) {
            file.readEntry();
            return;
          }
          file.openReadStream(entry, async (streamError, stream) => {
            if (streamError || !stream) {
              reject(streamError);
              return;
            }
            const chunks: Buffer[] = [];
            try {
              for await (const chunk of stream) chunks.push(chunk as Buffer);
            } catch (readError) {
              reject(
                new RequestError(
                  400,
                  "INVALID_DSYM_ARCHIVE",
                  String(readError),
                ),
              );
              return;
            }
            const data = Buffer.concat(chunks);
            // The server skips DWARF it cannot parse as Mach-O; tests mark such files.
            if (data.subarray(0, 9).toString() === "NOT-MACHO") {
              file.readEntry();
              return;
            }
            const key = `${match[1] ?? ""}/${match[2]}`;
            const bundle = bundles.get(key) ?? {
              id: randomUUID(),
              bundleName: match[2]!,
              version: "1.0",
              build: "1",
              url: "",
              slices: [],
            };
            bundle.url = `/crashes/dsyms/${bundle.id}`;
            bundle.slices.push({ uuid: uuidFrom(data), arch: "arm64" });
            bundles.set(key, bundle);
            file.readEntry();
          });
        });
        file.on("end", () => {
          if (!bundles.size) {
            reject(
              new RequestError(
                400,
                "INVALID_DSYM_ARCHIVE",
                "The zip holds no .dSYM bundles with DWARF files",
              ),
            );
            return;
          }
          resolve([...bundles.values()]);
        });
        file.readEntry();
      },
    );
  });
}

function body(upload: MockUpload, duplicate: boolean) {
  return {
    duplicate,
    upload: {
      id: upload.id,
      status: upload.status,
      buildId: upload.buildId,
      url: upload.url,
      projectName: upload.projectName,
    },
    dsyms: upload.dsyms,
  };
}

export async function startMockServer(
  options: MockServerOptions = {},
): Promise<MockServer> {
  const apiKey = options.apiKey ?? "aide_test";
  const requests: RecordedRequest[] = [];
  const uploads = new Map<string, MockUpload>();

  const withLock = <T>(upload: MockUpload, work: () => Promise<T>) => {
    const next = upload.lock.catch(() => undefined).then(work);
    upload.lock = next;
    return next;
  };

  const find = (id: string) => {
    const upload = uploads.get(id);
    if (!upload)
      throw new RequestError(404, "NOT_FOUND", "dSYM upload not found");
    return upload;
  };

  async function complete(upload: MockUpload): Promise<Reply> {
    return withLock(upload, async () => {
      if (upload.status === "READY") {
        return { status: 200, json: body(upload, true) };
      }
      if (upload.status !== "UPLOADING" || upload.offset !== upload.sizeBytes) {
        throw new RequestError(
          409,
          "INCOMPLETE_UPLOAD",
          `The upload is incomplete: ${upload.offset} of ${upload.sizeBytes} bytes received`,
        );
      }
      const zip = Buffer.concat(upload.chunks);
      const sha256 = createHash("sha256").update(zip).digest("hex");
      if (upload.sha256 && sha256 !== upload.sha256) {
        upload.status = "FAILED";
        throw new RequestError(
          422,
          "CHECKSUM_MISMATCH",
          "The uploaded bytes do not match the declared sha256",
        );
      }
      const earlier = [...uploads.values()].find(
        (other) =>
          other.id !== upload.id &&
          other.status === "READY" &&
          other.sha256 === sha256,
      );
      if (earlier) {
        uploads.delete(upload.id);
        return { status: 200, json: body(earlier, true) };
      }
      upload.status = "PROCESSING";
      await sleep(options.indexingMs ?? 0);
      try {
        upload.dsyms = await indexZip(zip);
      } catch (error) {
        upload.status = "FAILED";
        throw error;
      }
      upload.sha256 = sha256;
      upload.status = "READY";
      return { status: 201, json: body(upload, false) };
    });
  }

  async function handle(
    request: IncomingMessage,
    bytes: Buffer,
  ): Promise<Reply> {
    const url = new URL(request.url ?? "/", "http://mock.invalid");
    const method = request.method ?? "GET";
    if (url.pathname === "/__health")
      return { status: 200, json: { ok: true } };
    if (url.pathname === "/__requests") return { status: 200, json: requests };

    const key = request.headers["x-api-key"];
    if (request.headers.authorization && key) {
      throw new RequestError(
        400,
        "AUTHENTICATION_REQUIRED",
        "Provide exactly one application credential.",
      );
    }
    if (key !== apiKey) {
      throw new RequestError(
        401,
        "AUTHENTICATION_REQUIRED",
        "The API key is invalid or inactive.",
      );
    }

    const path = url.pathname.split("/").filter(Boolean);
    if (path.join("/") === "api/dsyms/uploads" && method === "POST") {
      const input = JSON.parse(bytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      const size = Number(input.sizeBytes);
      if (!Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 ** 3) {
        throw new RequestError(
          413,
          "PAYLOAD_TOO_LARGE",
          "sizeBytes must be between 1 byte and 20 GiB",
        );
      }
      const upload: MockUpload = {
        id: randomUUID(),
        filename: String(input.filename),
        sizeBytes: size,
        sha256: typeof input.sha256 === "string" ? input.sha256 : null,
        projectName: (input.projectName as string | null) ?? null,
        buildId: (input.buildId as string | null) ?? null,
        url: (input.url as string | null) ?? null,
        status: "UPLOADING",
        chunks: [],
        offset: 0,
        dsyms: [],
        lock: Promise.resolve(),
      };
      uploads.set(upload.id, upload);
      return {
        status: 201,
        headers: {
          location: `/api/dsyms/uploads/${upload.id}`,
          "upload-offset": "0",
        },
        json: { id: upload.id, uploadOffset: 0, chunkBytes: CHUNK_BYTES },
      };
    }

    if (
      path.length === 4 &&
      path.slice(0, 3).join("/") === "api/dsyms/uploads"
    ) {
      const upload = find(path[3]!);
      if (method === "HEAD") {
        return {
          status: 204,
          headers: {
            "upload-offset": String(upload.offset),
            "upload-length": String(upload.sizeBytes),
            "upload-status": upload.status,
          },
        };
      }
      if (method === "DELETE") {
        if (upload.status !== "UPLOADING") {
          throw new RequestError(
            409,
            "CONFLICT",
            "Only unfinished uploads can be cancelled here",
          );
        }
        uploads.delete(upload.id);
        return { status: 204 };
      }
      if (method === "PATCH") {
        return withLock(upload, async () => {
          if (upload.status !== "UPLOADING") {
            throw new RequestError(
              409,
              "CONFLICT",
              "The upload is no longer accepting data",
            );
          }
          const offset = Number(request.headers["upload-offset"]);
          if (offset !== upload.offset) {
            throw new RequestError(
              409,
              "OFFSET_MISMATCH",
              `Upload offset mismatch; expected ${upload.offset}`,
            );
          }
          if (
            !bytes.length ||
            bytes.length > CHUNK_BYTES ||
            offset + bytes.length > upload.sizeBytes
          ) {
            throw new RequestError(
              413,
              "PAYLOAD_TOO_LARGE",
              "Upload chunks must be 1 byte to 16 MiB",
            );
          }
          upload.chunks.push(bytes);
          upload.offset += bytes.length;
          return {
            status: 204,
            headers: {
              "upload-offset": String(upload.offset),
              "upload-length": String(upload.sizeBytes),
            },
          };
        });
      }
    }

    if (
      path.length === 5 &&
      path.slice(0, 3).join("/") === "api/dsyms/uploads" &&
      path[4] === "complete" &&
      method === "POST"
    ) {
      return complete(find(path[3]!));
    }
    throw new RequestError(404, "NOT_FOUND", "Not found");
  }

  function send(response: ServerResponse, reply: Reply) {
    const headers = { "cache-control": "no-store", ...reply.headers };
    if (reply.json === undefined) {
      response.writeHead(reply.status, headers).end();
      return;
    }
    response
      .writeHead(reply.status, {
        "content-type": "application/json",
        ...headers,
      })
      .end(JSON.stringify(reply.json));
  }

  const failure = (error: unknown): Reply =>
    error instanceof RequestError
      ? {
          status: error.status,
          json: { error: { code: error.code, message: error.message } },
        }
      : {
          status: 500,
          json: { error: { code: "INTERNAL_ERROR", message: String(error) } },
        };

  const server = createServer(async (request, response) => {
    const bytes = await readBody(request);
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      path: new URL(request.url ?? "/", "http://mock.invalid").pathname,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(", ") : (value ?? ""),
        ]),
      ),
      bodyBytes: bytes.length,
    };
    if (!recorded.path.startsWith("/__")) requests.push(recorded);

    const missing = Object.entries(options.requiredHeaders ?? {}).some(
      ([name, value]) => request.headers[name.toLowerCase()] !== value,
    );
    if (missing && !recorded.path.startsWith("/__")) {
      response
        .writeHead(302, {
          location:
            "https://example.cloudflareaccess.com/cdn-cgi/access/login/aide.example.com",
        })
        .end();
      return;
    }

    const fault = options.fault?.(recorded);
    const mode = fault?.mode ?? "instead";
    const work =
      !fault || mode !== "instead"
        ? handle(request, bytes).catch(failure)
        : null;
    if (fault) {
      if (mode === "after") await work;
      if (fault.delayMs) await sleep(fault.delayMs);
      if (fault.destroy) {
        request.socket.destroy();
        return;
      }
      response
        .writeHead(fault.status ?? 502, {
          "cache-control": "no-store",
          ...fault.headers,
        })
        .end(fault.body ?? "");
      return;
    }
    send(response, (await work)!);
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    uploads,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Faults for CI: a lost response, a gateway error, and a completion that outlives the proxy. */
function flakyFaults(): (request: RecordedRequest) => Fault | undefined {
  let patches = 0;
  let completions = 0;
  return (request) => {
    if (request.method === "PATCH") {
      patches += 1;
      if (patches === 2) return { mode: "instead", status: 502 };
      if (patches === 3) return { mode: "after", status: 502 };
    }
    if (request.method === "POST" && request.path.endsWith("/complete")) {
      completions += 1;
      if (completions === 1) return { mode: "background", status: 524 };
    }
    return undefined;
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const requiredHeaders: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== "--require-header") return;
    const header = args[index + 1] ?? "";
    const separator = header.indexOf(":");
    requiredHeaders[header.slice(0, separator).trim()] = header
      .slice(separator + 1)
      .trim();
  });
  const server = await startMockServer({
    port: Number(value("--port") ?? 8787),
    apiKey: value("--api-key") ?? "aide_test",
    requiredHeaders,
    indexingMs: Number(value("--indexing-ms") ?? 500),
    fault: args.includes("--flaky") ? flakyFaults() : undefined,
  });
  console.log(`Mock control plane listening on ${server.url}`);
}
