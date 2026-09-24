import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeBundle, temporaryDirectory } from "../test/helpers.js";
import {
  startMockServer,
  type Fault,
  type MockServer,
  type RecordedRequest,
} from "../test/mock-server.js";
import { hashFile, writeArchive, type ZipToUpload } from "./archive.js";
import { readBundle } from "./collect.js";
import { CancelledError, Client } from "./http.js";
import { MIB } from "./inputs.js";
import { uploadZip } from "./upload.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  info: vi.fn(),
}));

const metadata = {
  projectName: "bludesign/app",
  buildId: "42",
  url: "https://github.com/bludesign/app/actions/runs/42",
};

let root: string;
let server: MockServer;
let fault: ((request: RecordedRequest) => Fault | undefined) | undefined;
let controller: AbortController;
const sleeps: number[] = [];

beforeEach(async () => {
  root = await temporaryDirectory();
  fault = undefined;
  controller = new AbortController();
  sleeps.length = 0;
  server = await startMockServer({
    indexingMs: 50,
    fault: (request) => fault?.(request),
  });
});

afterEach(async () => {
  await server.close();
});

function client(retries = 3) {
  return new Client({
    origin: server.url,
    apiKey: "aide_test",
    headers: {
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "secret",
    },
    timeoutMs: 5_000,
    retries,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

/** A zip of one bundle with an incompressible DWARF file of `size` bytes. */
async function zipOf(
  size: number,
  name = "MyApp.app.dSYM",
): Promise<ZipToUpload> {
  const bundle = await makeBundle(join(root, "src"), name, {
    dwarf: { MyApp: randomBytes(size) },
  });
  return writeArchive([(await readBundle(bundle))!], root, `${name}.zip`);
}

const upload = (zip: ZipToUpload, retries?: number) =>
  uploadZip(client(retries), zip, metadata, { chunkBytes: MIB });

const byMethod = (method: string) =>
  server.requests.filter((request) => request.method === method);
const idOf = (request: RecordedRequest) => request.path.split("/")[4]!;
const stored = (id: string) =>
  createHash("sha256")
    .update(Buffer.concat(server.uploads.get(id)!.chunks))
    .digest("hex");

describe("uploadZip", () => {
  test("sends sequential chunks with the headers on every request", async () => {
    const zip = await zipOf(2.5 * MIB);
    const result = await upload(zip);

    expect(result.duplicate).toBe(false);
    expect(result.body!.dsyms.map((dsym) => dsym.bundleName)).toEqual([
      "MyApp.app.dSYM",
    ]);
    expect(server.requests.map((request) => request.method)).toEqual([
      "POST",
      "PATCH",
      "PATCH",
      "PATCH",
      "POST",
    ]);
    expect(
      byMethod("PATCH").map((request) => request.headers["upload-offset"]),
    ).toEqual(["0", String(MIB), String(2 * MIB)]);
    expect(
      Math.max(...byMethod("PATCH").map((request) => request.bodyBytes)),
    ).toBe(MIB);
    for (const request of server.requests) {
      expect(request.headers["x-api-key"]).toBe("aide_test");
      expect(request.headers["cf-access-client-id"]).toBe("id.access");
      expect(request.headers["cf-access-client-secret"]).toBe("secret");
    }
    expect(stored(result.id)).toBe(zip.sha256);
    expect(server.uploads.get(result.id)).toMatchObject({
      filename: "MyApp.app.dSYM.zip",
      sha256: zip.sha256,
      ...metadata,
    });
  });

  test("never sends more than the server's chunk size", async () => {
    const zip = await zipOf(1.5 * MIB);
    await uploadZip(client(), zip, metadata, { chunkBytes: 64 * MIB });
    expect(byMethod("PATCH")).toHaveLength(1);
  });

  test("resumes from the server's offset after a gateway error", async () => {
    const zip = await zipOf(2.5 * MIB);
    let patches = 0;
    fault = (request) =>
      request.method === "PATCH" && ++patches === 2
        ? { status: 502 }
        : undefined;
    const result = await upload(zip);

    expect(stored(result.id)).toBe(zip.sha256);
    expect(byMethod("HEAD")).toHaveLength(1);
    expect(sleeps).toHaveLength(1);
  });

  test("does not resend a chunk whose answer was lost", async () => {
    const zip = await zipOf(2.5 * MIB);
    let patches = 0;
    fault = (request) =>
      request.method === "PATCH" && ++patches === 1
        ? { mode: "after", destroy: true }
        : undefined;
    const result = await upload(zip);

    expect(stored(result.id)).toBe(zip.sha256);
    expect(
      byMethod("PATCH").map((request) => request.headers["upload-offset"]),
    ).toEqual(["0", String(MIB), String(2 * MIB)]);
  });

  test("asks for the offset after a conflict without waiting", async () => {
    const zip = await zipOf(2.5 * MIB);
    let patches = 0;
    fault = (request) =>
      request.method === "PATCH" && ++patches === 2
        ? {
            status: 409,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              error: {
                code: "OFFSET_MISMATCH",
                message: "Upload offset mismatch",
              },
            }),
          }
        : undefined;
    const result = await upload(zip);

    expect(stored(result.id)).toBe(zip.sha256);
    expect(byMethod("HEAD")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("asks again when completing outlives the proxy, and keeps its own upload", async () => {
    const zip = await zipOf(0.5 * MIB);
    let completions = 0;
    fault = (request) =>
      request.path.endsWith("/complete") && ++completions === 1
        ? { mode: "background", status: 524, headers: { "cf-ray": "1" } }
        : undefined;
    const result = await upload(zip);

    expect(
      byMethod("POST").filter((request) => request.path.endsWith("/complete")),
    ).toHaveLength(2);
    expect(result.duplicate).toBe(false);
    expect(result.id).toBe(idOf(byMethod("PATCH")[0]!));
    expect(sleeps).toEqual([5_000]);
  });

  test("reports a zip uploaded before as a duplicate of that upload", async () => {
    const zip = await zipOf(0.5 * MIB);
    const first = await upload(zip);
    const second = await upload(zip);

    expect(second).toMatchObject({ duplicate: true, id: first.id });
    expect(server.uploads.size).toBe(1);
  });

  test("treats an upload that vanished after a lost completion as a duplicate", async () => {
    const zip = await zipOf(0.5 * MIB);
    await upload(zip);
    let completions = 0;
    fault = (request) =>
      request.path.endsWith("/complete") && ++completions === 1
        ? { mode: "background", status: 524 }
        : undefined;
    expect(await upload(zip)).toMatchObject({ duplicate: true, body: null });
  });

  test("goes back to sending chunks when the server is missing bytes", async () => {
    const zip = await zipOf(1.5 * MIB);
    let completions = 0;
    fault = (request) => {
      if (request.path.endsWith("/complete") && ++completions === 1) {
        const saved = server.uploads.get(idOf(request))!;
        saved.offset -= saved.chunks.pop()!.length;
      }
      return undefined;
    };
    const result = await upload(zip);

    expect(stored(result.id)).toBe(zip.sha256);
    expect(byMethod("PATCH")).toHaveLength(3);
  });

  test("reports an upload the server stopped indexing", async () => {
    const zip = await zipOf(0.5 * MIB);
    fault = (request) => {
      if (request.path.endsWith("/complete")) {
        server.uploads.get(idOf(request))!.status = "PROCESSING";
      }
      return undefined;
    };
    await expect(upload(zip)).rejects.toThrow(/stopped indexing .* restarted/);
  });

  test("reports a zip the server could not index", async () => {
    const path = join(root, "junk.zip");
    await writeFile(path, randomBytes(1024));
    const junk: ZipToUpload = {
      path,
      filename: "junk.zip",
      ...(await hashFile(path)),
      bundles: null,
    };
    await expect(upload(junk)).rejects.toThrow("INVALID_DSYM_ARCHIVE");

    let completions = 0;
    fault = (request) =>
      request.path.endsWith("/complete") && ++completions === 1
        ? { mode: "background", status: 524 }
        : undefined;
    await expect(upload(junk)).rejects.toThrow(
      "Uploads in progress on the dSYMs page",
    );
  });

  test("fails on a checksum mismatch", async () => {
    const zip = await zipOf(0.5 * MIB);
    fault = (request) => {
      if (request.path.endsWith("/complete")) {
        const chunk = server.uploads.get(idOf(request))!.chunks[0]!;
        chunk[100] = chunk[100]! ^ 0xff;
      }
      return undefined;
    };
    await expect(upload(zip)).rejects.toThrow("CHECKSUM_MISMATCH");
  });

  test("deletes the unfinished upload after a failure", async () => {
    const zip = await zipOf(1.5 * MIB);
    fault = (request) =>
      request.method === "PATCH"
        ? {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              error: { code: "BAD_REQUEST", message: "Refused" },
            }),
          }
        : undefined;
    await expect(upload(zip)).rejects.toThrow("Refused (BAD_REQUEST)");
    expect(byMethod("DELETE")).toHaveLength(1);
    expect(server.uploads.size).toBe(0);
  });

  test("deletes the unfinished upload when cancelled", async () => {
    const zip = await zipOf(2.5 * MIB);
    let patches = 0;
    fault = (request) => {
      if (request.method === "PATCH" && ++patches === 2) {
        setTimeout(
          () => controller.abort(new CancelledError("Cancelled by SIGINT")),
          20,
        );
        return { status: 204, delayMs: 2_000 };
      }
      return undefined;
    };
    await expect(upload(zip)).rejects.toThrow("Cancelled by SIGINT");
    expect(byMethod("DELETE")).toHaveLength(1);
    expect(server.uploads.size).toBe(0);
  });

  test("gives up after the retry budget", async () => {
    const zip = await zipOf(0.5 * MIB);
    fault = (request) =>
      request.method === "PATCH" ? { status: 503 } : undefined;
    await expect(upload(zip, 2)).rejects.toThrow("returned 503");
    expect(byMethod("PATCH")).toHaveLength(3);
  });
});
