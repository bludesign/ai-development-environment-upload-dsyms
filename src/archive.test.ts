import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import {
  FIXTURE_ZIP,
  makeBundle,
  readZip,
  temporaryDirectory,
} from "../test/helpers.js";
import {
  archiveName,
  hashFile,
  planArchives,
  writeArchive,
  zipEntries,
} from "./archive.js";
import { readBundle, type DsymBundle } from "./collect.js";

// The control plane's indexer (src/services/crashes/dsym-index.ts in the app repo).
const DWARF_ENTRY =
  /^(?:(.*)\/)?([^/]+\.dSYM)\/Contents\/Resources\/DWARF\/([^/]+)$/i;
const PLIST_ENTRY = /^(?:(.*)\/)?([^/]+\.dSYM)\/Contents\/Info\.plist$/i;

let root: string;

beforeEach(async () => {
  root = await temporaryDirectory();
});

async function bundle(
  parent: string,
  name: string,
  dwarf?: Record<string, string | Buffer>,
) {
  return (await readBundle(await makeBundle(parent, name, { dwarf })))!;
}

function fakeBundle(name: string, sizeBytes = 1): DsymBundle {
  return {
    name,
    path: `/tmp/${name}`,
    infoPlist: null,
    dwarfFiles: [],
    sizeBytes,
  };
}

describe("writeArchive", () => {
  test("writes entries the control plane indexes, as regular files", async () => {
    const bundles = [
      await bundle(join(root, "a"), "MyApp.app.dSYM", {
        MyApp: randomBytes(4096),
      }),
      await bundle(join(root, "a"), "Widget.appex.dSYM"),
    ];
    const zip = await writeArchive(bundles, root, "dSYMs.zip");
    const entries = await readZip(zip.path);

    expect(entries.map((entry) => entry.name)).toEqual([
      "MyApp.app.dSYM/Contents/Info.plist",
      "MyApp.app.dSYM/Contents/Resources/DWARF/MyApp",
      "Widget.appex.dSYM/Contents/Info.plist",
      "Widget.appex.dSYM/Contents/Resources/DWARF/Widget",
    ]);
    for (const entry of entries) {
      expect(DWARF_ENTRY.test(entry.name) || PLIST_ENTRY.test(entry.name)).toBe(
        true,
      );
      expect(entry.mode & 0o170000).toBe(0o100000);
    }
    expect(entries[1]!.data.length).toBe(4096);
    expect(zip).toMatchObject({ filename: "dSYMs.zip", bundles });
    expect(await hashFile(zip.path)).toEqual({
      sha256: zip.sha256,
      sizeBytes: zip.sizeBytes,
    });
  });

  test("produces the same bytes in any time zone", async () => {
    const bundles = [
      await bundle(root, "MyApp.app.dSYM", { MyApp: randomBytes(2048) }),
    ];
    // A runner's time zone is fixed when the process starts; changing TZ inside
    // one process leaves V8's date cache half updated, so each zone gets its own.
    const script = `
      import { writeArchive } from ${JSON.stringify(new URL("./archive.ts", import.meta.url).href)};
      const zip = await writeArchive(JSON.parse(process.env.BUNDLES), process.env.OUT, process.env.NAME);
      console.log(zip.sha256);`;
    const hashes = ["UTC", "America/New_York", "Asia/Tokyo"].map(
      (zone, index) =>
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", script],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              TZ: zone,
              BUNDLES: JSON.stringify(bundles),
              OUT: root,
              NAME: `zone-${index}.zip`,
            },
          },
        ).trim(),
    );
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(1);
  });

  test("puts a second bundle with the same name under a numbered folder", async () => {
    const bundles = [
      await bundle(join(root, "device"), "MyApp.app.dSYM"),
      await bundle(join(root, "simulator"), "MyApp.app.dSYM"),
    ];
    const entries = await readZip(
      (await writeArchive(bundles, root, "dSYMs.zip")).path,
    );
    const dwarf = entries
      .map((entry) => DWARF_ENTRY.exec(entry.name))
      .filter((match) => match !== null)
      .map((match) => `${match[1] ?? ""}/${match[2]}`);
    expect(dwarf).toEqual(["2/MyApp.app.dSYM", "/MyApp.app.dSYM"]);
  });

  test("reports a file that vanished instead of crashing", async () => {
    const vanished: DsymBundle = {
      ...fakeBundle("Gone.dSYM"),
      dwarfFiles: [{ name: "Gone", path: join(root, "missing"), sizeBytes: 1 }],
    };
    await expect(writeArchive([vanished], root, "dSYMs.zip")).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe("zipEntries", () => {
  test("names entries from the bundle down with forward slashes", async () => {
    const read = await bundle(join(root, "deep", "path"), "App.dSYM");
    expect(zipEntries([read]).map((entry) => entry.name)).toEqual([
      "App.dSYM/Contents/Info.plist",
      "App.dSYM/Contents/Resources/DWARF/App",
    ]);
  });
});

describe("planArchives", () => {
  test("keeps up to 500 bundles in one zip", () => {
    const bundles = Array.from({ length: 501 }, (_, index) =>
      fakeBundle(`B${String(index).padStart(3, "0")}.dSYM`),
    );
    const groups = planArchives(bundles);
    expect(groups.map((group) => group.length)).toEqual([500, 1]);
    expect(groups[1]![0]!.name).toBe("B500.dSYM");
  });

  test("starts a new zip before the size limit", () => {
    const groups = planArchives(
      [
        fakeBundle("C.dSYM", 6),
        fakeBundle("A.dSYM", 6),
        fakeBundle("B.dSYM", 6),
      ],
      { maxBundles: 500, maxBytes: 12 },
    );
    expect(groups.map((group) => group.map((item) => item.name))).toEqual([
      ["A.dSYM", "B.dSYM"],
      ["C.dSYM"],
    ]);
  });

  test("gives a bundle over the size limit a zip of its own", () => {
    const groups = planArchives([fakeBundle("Huge.dSYM", 50)], {
      maxBundles: 500,
      maxBytes: 10,
    });
    expect(groups).toHaveLength(1);
  });

  test("names the zips", () => {
    expect([0, 1, 2].map(archiveName)).toEqual([
      "dSYMs.zip",
      "dSYMs-2.zip",
      "dSYMs-3.zip",
    ]);
  });
});

describe("hashFile", () => {
  test("hashes the fixture", async () => {
    expect(await hashFile(FIXTURE_ZIP)).toEqual({
      sha256:
        "b07edf4e39ba257f16c6794a3cc21a159788b02f6300b099b32504d1e6183175",
      sizeBytes: 5918,
    });
  });
});
