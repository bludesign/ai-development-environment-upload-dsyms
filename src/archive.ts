import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import yazl from "yazl";

import type { DsymBundle } from "./collect.js";

/** Most `.dSYM` bundles the control plane indexes from one zip. */
export const MAX_BUNDLES_PER_ZIP = 500;
/** Source bytes per zip, which keeps each zip under the upload limit. */
export const MAX_ZIP_SOURCE_BYTES = 19 * 1024 ** 3;
/** Largest zip the control plane accepts through the resumable upload. */
export const MAX_UPLOAD_BYTES = 20 * 1024 ** 3;

/**
 * DOS timestamps carry no time zone and yazl writes them in local time, so
 * local midnight on 1980-01-01 (and no UTC extra field) makes the same dSYMs
 * produce the same zip on every runner. The server stores an identical zip once.
 */
function entryOptions() {
  return {
    mtime: new Date(1980, 0, 1),
    mode: 0o100644,
    forceDosTimestamp: true,
  };
}

export type ZipToUpload = {
  path: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  /** The bundles in a zip this action built; null for a zip given in `dsym_paths`. */
  bundles: DsymBundle[] | null;
};

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Splits bundles into zips the control plane accepts, in a stable order. */
export function planArchives(
  bundles: DsymBundle[],
  limits = { maxBundles: MAX_BUNDLES_PER_ZIP, maxBytes: MAX_ZIP_SOURCE_BYTES },
): DsymBundle[][] {
  const groups: DsymBundle[][] = [];
  let current: DsymBundle[] = [];
  let bytes = 0;
  const sorted = [...bundles].sort(
    (a, b) => compare(a.name, b.name) || compare(a.path, b.path),
  );
  for (const bundle of sorted) {
    if (
      current.length &&
      (current.length >= limits.maxBundles ||
        bytes + bundle.sizeBytes > limits.maxBytes)
    ) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(bundle);
    bytes += bundle.sizeBytes;
  }
  if (current.length) groups.push(current);
  return groups;
}

export function archiveName(index: number): string {
  return index === 0 ? "dSYMs.zip" : `dSYMs-${index + 1}.zip`;
}

/**
 * The zip's entries, named from each bundle down. A second bundle with the
 * same name goes under `2/`, which the server reads as a separate bundle.
 */
export function zipEntries(
  bundles: DsymBundle[],
): { name: string; path: string }[] {
  const seen = new Map<string, number>();
  const entries: { name: string; path: string }[] = [];
  for (const bundle of bundles) {
    const count = (seen.get(bundle.name) ?? 0) + 1;
    seen.set(bundle.name, count);
    const root = `${count === 1 ? "" : `${count}/`}${bundle.name}/Contents`;
    if (bundle.infoPlist) {
      entries.push({ name: `${root}/Info.plist`, path: bundle.infoPlist.path });
    }
    for (const file of bundle.dwarfFiles) {
      entries.push({
        name: `${root}/Resources/DWARF/${file.name}`,
        path: file.path,
      });
    }
  }
  return entries.sort((a, b) => compare(a.name, b.name));
}

function digestStream() {
  const digest = createHash("sha256");
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    transform,
    result: () => ({ sha256: digest.digest("hex"), sizeBytes: size }),
  };
}

/** Zips bundles into `directory`, hashing the zip as it is written. */
export async function writeArchive(
  bundles: DsymBundle[],
  directory: string,
  filename: string,
): Promise<ZipToUpload> {
  const path = join(directory, filename);
  const zip = new yazl.ZipFile();
  const digest = digestStream();
  await new Promise<void>((resolve, reject) => {
    // yazl reports files it cannot read here, not on the output stream.
    zip.on("error", reject);
    pipeline(
      zip.outputStream,
      digest.transform,
      createWriteStream(path, { mode: 0o600 }),
    ).then(resolve, reject);
    const options = entryOptions();
    for (const entry of zipEntries(bundles)) {
      zip.addFile(entry.path, entry.name, options);
    }
    zip.end();
  });
  return { path, filename, ...digest.result(), bundles };
}

/** Hashes a zip given in `dsym_paths`, which is uploaded unchanged. */
export async function hashFile(
  path: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const digest = digestStream();
  await pipeline(
    createReadStream(path),
    digest.transform,
    new Writable({ write: (_chunk, _encoding, callback) => callback() }),
  );
  return digest.result();
}
