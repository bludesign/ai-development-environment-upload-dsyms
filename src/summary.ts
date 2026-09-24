import * as core from "@actions/core";

import type { ZipToUpload } from "./archive.js";
import { formatBytes } from "./format.js";
import type { UploadResult, UploadedDsym } from "./upload.js";

export type UploadReport = {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  duplicate: boolean;
  /** Each dSYM's `url` is absolute. */
  dsyms: UploadedDsym[];
};

export function toReport(
  zip: ZipToUpload,
  result: UploadResult,
  origin: string,
): UploadReport {
  return {
    id: result.id,
    filename: zip.filename,
    sizeBytes: zip.sizeBytes,
    sha256: zip.sha256,
    duplicate: result.duplicate,
    dsyms: (result.body?.dsyms ?? []).map((dsym) => ({
      ...dsym,
      url: new URL(dsym.url, origin).toString(),
    })),
  };
}

export function versionText(dsym: {
  version: string | null;
  build: string | null;
}): string {
  if (dsym.version && dsym.build) return `${dsym.version} (${dsym.build})`;
  return dsym.version ?? dsym.build ?? "—";
}

export function setOutputs(reports: UploadReport[]): void {
  core.setOutput("uploads", JSON.stringify(reports));
  const uuids = new Set(
    reports.flatMap((report) =>
      report.dsyms.flatMap((dsym) => dsym.slices.map((slice) => slice.uuid)),
    ),
  );
  core.setOutput("uuids", [...uuids].join("\n"));
}

function escape(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );
}

function header(...labels: string[]) {
  return labels.map((data) => ({ data, header: true }));
}

/** Writes the job summary, which only exists inside a runner. */
export async function writeSummary(
  reports: UploadReport[],
  origin: string,
): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = reports.flatMap((report) =>
    report.dsyms.map((dsym) => [
      `<a href="${escape(dsym.url)}">${escape(dsym.bundleName)}</a>`,
      escape(versionText(dsym)),
      dsym.slices
        .map(
          (slice) => `<code>${escape(slice.uuid)}</code> ${escape(slice.arch)}`,
        )
        .join("<br>"),
      report.duplicate ? "Already uploaded" : "Uploaded",
    ]),
  );
  const summary = core.summary.addHeading("dSYMs uploaded", 3);
  if (rows.length) {
    summary.addTable([header("dSYM", "Version", "UUIDs", "Status"), ...rows]);
  }
  for (const report of reports) {
    if (!report.dsyms.length) {
      summary.addRaw(
        `<p>${escape(report.filename)} matched dSYMs uploaded earlier.</p>`,
        true,
      );
    }
  }
  summary.addLink("Open the dSYMs page", `${origin}/crashes/dsyms`);
  await summary.write();
}

export async function writeDryRunSummary(zips: ZipToUpload[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await core.summary
    .addHeading("dSYMs found (dry run)", 3)
    .addTable([
      header("Zip", "dSYMs", "Size", "SHA-256"),
      ...zips.map((zip) => [
        escape(zip.filename),
        zip.bundles
          ? zip.bundles.map((bundle) => escape(bundle.name)).join("<br>")
          : "As given",
        formatBytes(zip.sizeBytes),
        `<code>${zip.sha256}</code>`,
      ]),
    ])
    .write();
}
