import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "@actions/core";

import {
  MAX_UPLOAD_BYTES,
  archiveName,
  hashFile,
  planArchives,
  writeArchive,
  type ZipToUpload,
} from "./archive.js";
import { collect, type Collected } from "./collect.js";
import { errorMessage, formatBytes } from "./format.js";
import { CancelledError, Client } from "./http.js";
import { readInputs } from "./inputs.js";
import {
  setOutputs,
  toReport,
  versionText,
  writeDryRunSummary,
  writeSummary,
  type UploadReport,
} from "./summary.js";
import { uploadZip, type UploadResult } from "./upload.js";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function proxyNotice(): void {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (proxy && !process.env.NODE_USE_ENV_PROXY) {
    core.notice(
      "A proxy is configured, but Node.js only sends requests through it when NODE_USE_ENV_PROXY is 1. Set NODE_USE_ENV_PROXY: 1 in the step's env to upload through the proxy.",
    );
  }
}

function describeFound(collected: Collected): void {
  for (const bundle of collected.bundles) {
    core.info(
      `Found ${bundle.name} (${formatBytes(bundle.sizeBytes)}) at ${bundle.path}`,
    );
  }
  for (const zip of collected.zips) {
    core.info(`Found ${zip.filename} at ${zip.path}`);
  }
}

async function prepareZips(
  collected: Collected,
  directory: string,
  signal: AbortSignal,
): Promise<ZipToUpload[]> {
  const zips: ZipToUpload[] = [];
  for (const [index, group] of planArchives(collected.bundles).entries()) {
    if (signal.aborted) throw new CancelledError();
    const zip = await writeArchive(group, directory, archiveName(index));
    core.info(
      `Zipped ${plural(group.length, "dSYM")} into ${zip.filename}: ${formatBytes(zip.sizeBytes)}, sha256 ${zip.sha256}`,
    );
    zips.push(zip);
  }
  for (const input of collected.zips) {
    if (signal.aborted) throw new CancelledError();
    zips.push({ ...input, ...(await hashFile(input.path)), bundles: null });
  }
  return zips;
}

function logResult(zip: ZipToUpload, result: UploadResult): void {
  if (!result.body) {
    core.warning(
      `${zip.filename} matched dSYMs uploaded earlier, so the server kept that upload.`,
    );
    return;
  }
  core.info(
    result.duplicate
      ? `${zip.filename} was uploaded before, so the server kept upload ${result.id}.`
      : `Uploaded ${zip.filename} as upload ${result.id}.`,
  );
  for (const dsym of result.body.dsyms) {
    const slices = dsym.slices
      .map((slice) => `${slice.uuid} (${slice.arch})`)
      .join(", ");
    core.info(`  ${dsym.bundleName} ${versionText(dsym)}: ${slices}`);
  }
  // The server skips DWARF files it cannot read as Mach-O without failing the upload.
  const expected = zip.bundles?.length ?? 0;
  if (expected > result.body.dsyms.length) {
    const indexed = new Set(result.body.dsyms.map((dsym) => dsym.bundleName));
    const missing = [
      ...new Set(
        zip
          .bundles!.map((bundle) => bundle.name)
          .filter((name) => !indexed.has(name)),
      ),
    ];
    core.warning(
      `The server indexed ${result.body.dsyms.length} of the ${expected} dSYMs in ${zip.filename}${missing.length ? `; it found no readable DWARF in ${missing.join(", ")}` : ""}.`,
    );
  }
}

export async function run(signal: AbortSignal): Promise<void> {
  const inputs = readInputs();
  proxyNotice();

  core.startGroup("Finding dSYMs");
  let collected: Collected;
  try {
    collected = await collect(inputs.patterns);
    describeFound(collected);
  } finally {
    core.endGroup();
  }
  if (!collected.bundles.length && !collected.zips.length) {
    setOutputs([]);
    const message = "No dSYMs matched dsym_paths";
    if (inputs.ifNoFilesFound === "error") {
      throw new Error(
        `${message}. Check the paths, or set if_no_files_found to warn or ignore.`,
      );
    }
    if (inputs.ifNoFilesFound === "warn") core.warning(message);
    else core.info(message);
    return;
  }

  const directory = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), "upload-dsyms-"),
  );
  try {
    const zips = await prepareZips(collected, directory, signal);
    if (inputs.dryRun) {
      for (const zip of zips) {
        core.info(
          `Would upload ${zip.filename}: ${formatBytes(zip.sizeBytes)}, sha256 ${zip.sha256}`,
        );
      }
      core.info("dry_run is on, so nothing was uploaded.");
      setOutputs([]);
      await writeDryRunSummary(zips);
      return;
    }

    const origin = inputs.origin!;
    const client = new Client({
      origin,
      apiKey: inputs.apiKey!,
      headers: inputs.headers,
      timeoutMs: inputs.timeoutMs,
      retries: inputs.retries,
      signal,
    });
    const extra = Object.keys(inputs.headers);
    if (extra.length) core.info(`Sending extra headers: ${extra.join(", ")}`);

    const reports: UploadReport[] = [];
    const failures: { filename: string; error: unknown }[] = [];
    for (const zip of zips) {
      core.startGroup(`Uploading ${zip.filename}`);
      try {
        if (zip.sizeBytes > MAX_UPLOAD_BYTES) {
          throw new Error(
            `${zip.filename} is ${formatBytes(zip.sizeBytes)}, and the control plane accepts zips of up to 20 GiB`,
          );
        }
        const result = await uploadZip(client, zip, inputs.metadata, {
          chunkBytes: inputs.chunkBytes,
        });
        logResult(zip, result);
        reports.push(toReport(zip, result, origin));
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push({ filename: zip.filename, error });
        if (zips.length > 1) {
          core.error(`${zip.filename}: ${errorMessage(error)}`);
        }
      } finally {
        core.endGroup();
      }
    }

    setOutputs(reports);
    await writeSummary(reports, origin);
    if (failures.length === 1 && zips.length === 1) throw failures[0]!.error;
    if (failures.length) {
      throw new Error(
        `${failures.length} of ${zips.length} zips failed to upload: ${failures.map((failure) => failure.filename).join(", ")}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
