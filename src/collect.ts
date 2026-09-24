import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import * as core from "@actions/core";
import * as glob from "@actions/glob";

import { errorMessage } from "./format.js";

export type DsymFile = { path: string; sizeBytes: number };

export type DsymBundle = {
  /** The bundle folder's name, such as `MyApp.app.dSYM`. */
  name: string;
  /** Real path of the bundle folder. */
  path: string;
  infoPlist: DsymFile | null;
  /** Files directly under `Contents/Resources/DWARF`, by name. */
  dwarfFiles: (DsymFile & { name: string })[];
  /** Bytes of the files the zip will hold, before compression. */
  sizeBytes: number;
};

export type ZipInput = { path: string; filename: string };

export type Collected = { bundles: DsymBundle[]; zips: ZipInput[] };

const BUNDLE = /\.dSYM$/i;

async function fileAt(path: string): Promise<DsymFile | null> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? { path, sizeBytes: info.size } : null;
}

/**
 * Reads the parts of a `.dSYM` the control plane keeps: `Contents/Info.plist`
 * and the DWARF files. Symbolic links to files are read through; the server
 * refuses links inside a zip.
 */
export async function readBundle(path: string): Promise<DsymBundle | null> {
  const name = basename(path);
  if (name.includes("\\")) {
    core.warning(
      `Skipping ${path}: the control plane refuses backslashes in zip entry names`,
    );
    return null;
  }
  const dwarfDirectory = join(path, "Contents", "Resources", "DWARF");
  const names = await readdir(dwarfDirectory).catch(() => [] as string[]);
  const dwarfFiles: DsymBundle["dwarfFiles"] = [];
  for (const file of names.sort()) {
    if (file.startsWith(".") || file.includes("\\")) continue;
    const found = await fileAt(join(dwarfDirectory, file));
    if (found) dwarfFiles.push({ name: file, ...found });
  }
  if (!dwarfFiles.length) {
    core.warning(
      `Skipping ${path}: it has no DWARF files in Contents/Resources/DWARF. Build with DEBUG_INFORMATION_FORMAT=dwarf-with-dsym.`,
    );
    return null;
  }
  const infoPlist = await fileAt(join(path, "Contents", "Info.plist"));
  return {
    name,
    path,
    infoPlist,
    dwarfFiles,
    sizeBytes:
      (infoPlist?.sizeBytes ?? 0) +
      dwarfFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

/**
 * Finds the `.dSYM` bundles in a folder. Folder links are not followed, so a
 * link cycle cannot trap the walk, except a link that is itself a `.dSYM`.
 */
async function findBundles(directory: string): Promise<string[]> {
  if (BUNDLE.test(directory)) return [directory];
  const found: string[] = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      core.warning(`Skipping ${current}: ${errorMessage(error)}`);
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        if (BUNDLE.test(entry.name)) found.push(child);
        else pending.push(child);
      } else if (entry.isSymbolicLink() && BUNDLE.test(entry.name)) {
        const target = await realpath(child).catch(() => null);
        const info = target ? await stat(target).catch(() => null) : null;
        if (target && info?.isDirectory()) found.push(target);
      }
    }
  }
  return found.sort();
}

/** Whether `path` lies inside one of `folders`. */
function isInside(path: string, folders: Set<string>): boolean {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (folders.has(parent)) return true;
    if (parent === dirname(parent)) return false;
  }
}

/** Drops folders inside other folders, so a `**` pattern walks each tree once. */
function outermost(folders: string[]): Set<string> {
  const kept = new Set<string>();
  const byDepth = [...new Set(folders)].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const folder of byDepth) {
    if (!isInside(folder, kept)) kept.add(folder);
  }
  return kept;
}

/**
 * Resolves `dsym_paths` into bundles to zip and zips to upload as they are.
 * A matched `.dSYM` is a bundle, any other matched folder (an `.xcarchive`, its
 * `dSYMs` folder, build products) is searched for bundles, and a matched `.zip`
 * is uploaded unchanged.
 */
export async function collect(patterns: string): Promise<Collected> {
  const globber = await glob.create(patterns, {
    matchDirectories: true,
    implicitDescendants: false,
  });
  const folders: string[] = [];
  const files: { match: string; real: string }[] = [];
  for (const match of await globber.glob()) {
    const info = await stat(match).catch(() => null);
    if (!info) continue;
    const real = await realpath(match);
    if (info.isDirectory()) folders.push(real);
    else if (info.isFile()) files.push({ match, real });
  }

  const roots = outermost(folders);
  const zips = new Map<string, ZipInput>();
  for (const { match, real } of files) {
    if (/\.zip$/i.test(match)) {
      zips.set(real, { path: real, filename: basename(match) });
    } else if (!isInside(real, roots)) {
      core.warning(
        `Skipping ${match}: it is not a .dSYM bundle, a folder, or a .zip file`,
      );
    }
  }

  const bundles = new Map<string, DsymBundle>();
  for (const root of [...roots].sort()) {
    for (const path of await findBundles(root)) {
      if (bundles.has(path)) continue;
      const bundle = await readBundle(path);
      if (bundle) bundles.set(path, bundle);
    }
  }
  return { bundles: [...bundles.values()], zips: [...zips.values()] };
}
