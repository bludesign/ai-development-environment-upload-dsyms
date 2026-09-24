import { open, type FileHandle } from "node:fs/promises";

import * as core from "@actions/core";

import type { ZipToUpload } from "./archive.js";
import { formatBytes, formatDuration } from "./format.js";
import { HttpError, type Client } from "./http.js";
import type { UploadMetadata } from "./inputs.js";

const UPLOADS = "/api/dsyms/uploads";
/** How long to keep asking `/complete` while the server indexes a zip. */
export const COMPLETION_DEADLINE_MS = 60 * 60_000;
/** Pause before asking `/complete` again after a request timed out mid-indexing. */
const INDEXING_PAUSE_MS = 5_000;
/** Offset conflicts in a row before giving up; each is resolved by asking for the offset. */
const MAX_CONFLICTS = 5;

export type DsymSlice = { uuid: string; arch: string };

export type UploadedDsym = {
  id: string;
  bundleName: string;
  version: string | null;
  build: string | null;
  /** Dashboard path, relative to the control plane. */
  url: string;
  slices: DsymSlice[];
};

export type DsymUploadBody = {
  duplicate: boolean;
  upload: { id: string; status: string };
  dsyms: UploadedDsym[];
};

export type UploadResult = {
  /** The upload that holds the dSYMs: this one, or an earlier one of the same zip. */
  id: string;
  duplicate: boolean;
  /** Null when the zip matched an earlier upload but the server's answer was lost. */
  body: DsymUploadBody | null;
};

export type UploadOptions = {
  chunkBytes: number;
  completionDeadlineMs?: number;
  now?: () => number;
};

type Upload = {
  client: Client;
  zip: ZipToUpload;
  id: string;
  path: string;
};

async function readChunk(
  file: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (!bytesRead) throw new Error("The zip changed while it was uploading");
    filled += bytesRead;
  }
  return buffer;
}

function progressLogger(zip: ZipToUpload) {
  let reported = -1;
  return (offset: number) => {
    const tenth = Math.floor((offset / zip.sizeBytes) * 10);
    if (tenth === reported) return;
    reported = tenth;
    core.info(
      `Uploaded ${formatBytes(offset)} of ${formatBytes(zip.sizeBytes)} (${Math.floor((offset / zip.sizeBytes) * 100)}%)`,
    );
  };
}

/** Reads the server's offset and status for the upload. */
async function serverStatus(
  upload: Upload,
): Promise<{ offset: number; status: string }> {
  const { client, zip, id, path } = upload;
  let response: Response;
  try {
    response = await client.withRetry(`Checking ${zip.filename}`, () =>
      client.send({ method: "HEAD", path }),
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new Error(
        `The server no longer has upload ${id}. It may have been cancelled on the dSYMs page, or expired after 24 hours without progress.`,
        { cause: error },
      );
    }
    throw error;
  }
  const offset = Number(response.headers.get("upload-offset"));
  const length = response.headers.get("upload-length");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > zip.sizeBytes) {
    throw new Error(`HEAD ${path} returned no usable Upload-Offset`);
  }
  if (length !== null && Number(length) !== zip.sizeBytes) {
    throw new Error(
      `The server expects ${length} bytes for upload ${id}, not ${zip.sizeBytes}`,
    );
  }
  return {
    offset,
    status: response.headers.get("upload-status")?.toUpperCase() || "UPLOADING",
  };
}

/**
 * Sends the zip from `start` in sequential chunks. A transient failure, or a
 * conflict after a chunk that landed without its answer, resumes from the
 * offset the server reports.
 */
async function sendChunks(
  upload: Upload,
  file: FileHandle,
  chunkBytes: number,
  start: number,
): Promise<void> {
  const { client, zip, path } = upload;
  const progress = progressLogger(zip);
  let offset = start;
  let failures = 0;
  let conflicts = 0;
  while (offset < zip.sizeBytes) {
    const length = Math.min(chunkBytes, zip.sizeBytes - offset);
    const bytes = await readChunk(file, offset, length);
    try {
      const response = await client.send({
        method: "PATCH",
        path,
        headers: {
          "content-type": "application/offset+octet-stream",
          "upload-offset": String(offset),
        },
        body: bytes,
      });
      const next = Number(response.headers.get("upload-offset"));
      offset =
        Number.isSafeInteger(next) && next > offset && next <= zip.sizeBytes
          ? next
          : offset + length;
      failures = 0;
      conflicts = 0;
      progress(offset);
      continue;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 409) {
        if (++conflicts > MAX_CONFLICTS) throw error;
      } else {
        if (!error.retryable || ++failures > client.retries) throw error;
        await client.pause(failures, error, `Uploading ${zip.filename}`);
      }
    }
    const current = await serverStatus(upload);
    // Anything but UPLOADING means every byte already arrived.
    if (current.status !== "UPLOADING") return;
    offset = current.offset;
  }
}

/**
 * Asks the server to verify and index the zip. Indexing can outlast a proxy's
 * timeout (Cloudflare gives up after 125 s) while the server keeps working, and
 * asking again waits for that work and returns its result.
 */
async function complete(
  upload: Upload,
  options: UploadOptions,
): Promise<UploadResult | { resumeAt: number }> {
  const { client, zip, id, path } = upload;
  const now = options.now ?? Date.now;
  const deadlineMs = options.completionDeadlineMs ?? COMPLETION_DEADLINE_MS;
  const deadline = now() + deadlineMs;
  let failures = 0;
  let attempted = false;
  for (;;) {
    try {
      const body = await client.json<DsymUploadBody>({
        method: "POST",
        path: `${path}/complete`,
      });
      const holder = body.upload?.id ?? id;
      // The server answers a finished upload with duplicate: true and its own id.
      return {
        id: holder,
        duplicate: Boolean(body.duplicate) && holder !== id,
        body,
      };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 404 && attempted) {
        // An earlier attempt finished unseen, and the zip matched an earlier upload.
        return { id, duplicate: true, body: null };
      }
      if (error.status === 409) {
        const current = await serverStatus(upload);
        if (current.status === "UPLOADING" && current.offset < zip.sizeBytes) {
          return { resumeAt: current.offset };
        }
        if (current.status === "PROCESSING") {
          // A live indexing run holds the upload's lock, so a second request would wait for it.
          throw new Error(
            `The server stopped indexing upload ${id}, most likely because it restarted. Run the step again.`,
            { cause: error },
          );
        }
        if (current.status === "FAILED") {
          throw new Error(
            `The server could not index ${zip.filename}. Uploads in progress on the dSYMs page shows why.`,
            { cause: error },
          );
        }
        if (++failures > client.retries) throw error;
        continue;
      }
      if (error.timedOut || error.status === 504 || error.status === 524) {
        attempted = true;
        if (now() >= deadline) {
          throw new Error(
            `The server was still indexing ${zip.filename} after ${formatDuration(deadlineMs)}`,
            { cause: error },
          );
        }
        core.info(
          `The server is still indexing ${zip.filename} (${error.message.replace(/\.$/, "")}); asking again.`,
        );
        await client.wait(INDEXING_PAUSE_MS);
        continue;
      }
      if (!error.retryable || ++failures > client.retries) throw error;
      attempted = true;
      await client.pause(failures, error, `Completing ${zip.filename}`);
    }
  }
}

/** Best effort: frees the server's staging file for an upload that will not finish. */
async function discard(upload: Upload): Promise<void> {
  try {
    await upload.client.send({
      method: "DELETE",
      path: upload.path,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Only an unfinished upload can be deleted; one that finished stays.
  }
}

/**
 * Uploads one zip through the control plane's resumable protocol: start, send
 * chunks of at most `chunkBytes`, then complete. Every request stays below
 * proxy body limits such as Cloudflare's 100 MB.
 */
export async function uploadZip(
  client: Client,
  zip: ZipToUpload,
  metadata: UploadMetadata,
  options: UploadOptions,
): Promise<UploadResult> {
  const started = await client.withRetry(`Starting ${zip.filename}`, () =>
    client.json<{ id?: unknown; chunkBytes?: unknown }>({
      method: "POST",
      path: UPLOADS,
      json: {
        filename: zip.filename,
        sizeBytes: zip.sizeBytes,
        sha256: zip.sha256,
        projectName: metadata.projectName,
        buildId: metadata.buildId,
        url: metadata.url,
      },
    }),
  );
  if (typeof started.id !== "string" || !started.id) {
    throw new Error(`POST ${UPLOADS} did not return an upload id`);
  }
  const upload: Upload = {
    client,
    zip,
    id: started.id,
    path: `${UPLOADS}/${encodeURIComponent(started.id)}`,
  };
  const serverChunk = Number(started.chunkBytes);
  const chunkBytes =
    Number.isSafeInteger(serverChunk) && serverChunk > 0
      ? Math.min(options.chunkBytes, serverChunk)
      : options.chunkBytes;
  core.info(
    `Started upload ${upload.id}: ${formatBytes(zip.sizeBytes)} in chunks of up to ${formatBytes(chunkBytes)}`,
  );

  const file = await open(zip.path, "r");
  try {
    let offset = 0;
    for (;;) {
      await sendChunks(upload, file, chunkBytes, offset);
      const outcome = await complete(upload, options);
      if (!("resumeAt" in outcome)) return outcome;
      offset = outcome.resumeAt;
    }
  } catch (error) {
    await discard(upload);
    throw error;
  } finally {
    await file.close();
  }
}
