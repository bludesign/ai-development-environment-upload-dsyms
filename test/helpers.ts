import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import yauzl, { type Entry } from "yauzl";

export const FIXTURE_ZIP = fileURLToPath(
  new URL("./fixtures/CrashDemo.dSYM.zip", import.meta.url),
);

export function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "upload-dsyms-test-"));
}

export async function writeFileAt(
  path: string,
  content: string | Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** Creates `parent/name` with an Info.plist and DWARF files. */
export async function makeBundle(
  parent: string,
  name: string,
  options: {
    dwarf?: Record<string, string | Buffer>;
    plist?: string | null;
  } = {},
): Promise<string> {
  const bundle = join(parent, name);
  const binary = name.replace(/(\.app|\.appex|\.framework)?\.dSYM$/i, "");
  const dwarf = options.dwarf ?? { [binary]: `DWARF for ${name}` };
  for (const [file, content] of Object.entries(dwarf)) {
    await writeFileAt(
      join(bundle, "Contents", "Resources", "DWARF", file),
      content,
    );
  }
  if (options.plist !== null) {
    await writeFileAt(
      join(bundle, "Contents", "Info.plist"),
      options.plist ?? `<plist><string>${name}</string></plist>`,
    );
  }
  return bundle;
}

export type ZipEntry = { name: string; mode: number; data: Buffer };

/** Reads a zip with the options the control plane's indexer uses. */
export function readZip(path: string): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(error);
        const entries: ZipEntry[] = [];
        zip.on("error", reject);
        zip.on("end", () => resolve(entries));
        zip.on("entry", (entry: Entry) => {
          zip.openReadStream(entry, async (streamError, stream) => {
            if (streamError || !stream) return reject(streamError);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk as Buffer);
            entries.push({
              name: entry.fileName,
              mode: entry.externalFileAttributes >>> 16,
              data: Buffer.concat(chunks),
            });
            zip.readEntry();
          });
        });
        zip.readEntry();
      },
    );
  });
}

/** Unzips the CrashDemo fixture into `destination`. */
export async function extractFixture(destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(FIXTURE_ZIP, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: Entry) => {
        const target = join(destination, entry.fileName);
        if (entry.fileName.endsWith("/")) {
          mkdir(target, { recursive: true }).then(
            () => zip.readEntry(),
            reject,
          );
          return;
        }
        zip.openReadStream(entry, async (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          await mkdir(dirname(target), { recursive: true });
          await pipeline(stream, createWriteStream(target));
          zip.readEntry();
        });
      });
      zip.readEntry();
    });
  });
}

/** Parses the `name<<delimiter` file that `core.setOutput` writes. */
export async function readOutputs(
  path: string,
): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8");
  const outputs: Record<string, string> = {};
  const pattern = /^(.+?)<<(ghadelimiter_[^\n]+)\n([\s\S]*?)\n\2$/gm;
  for (const match of text.matchAll(pattern)) outputs[match[1]!] = match[3]!;
  return outputs;
}
