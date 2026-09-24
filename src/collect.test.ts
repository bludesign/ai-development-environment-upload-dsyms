import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  FIXTURE_ZIP,
  makeBundle,
  temporaryDirectory,
  writeFileAt,
} from "../test/helpers.js";
import { collect, readBundle } from "./collect.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const core = await import("@actions/core");

let root: string;

beforeEach(async () => {
  root = await realpath(await temporaryDirectory());
});

afterEach(() => {
  vi.clearAllMocks();
});

/** An archive laid out as `xcodebuild archive` writes it. */
async function makeArchive(name = "MyApp") {
  const archive = join(root, "build", `${name}.xcarchive`);
  await makeBundle(join(archive, "dSYMs"), `${name}.app.dSYM`);
  await makeBundle(join(archive, "dSYMs"), "Widget.appex.dSYM");
  await writeFileAt(
    join(archive, "Products", "Applications", `${name}.app`, name),
    "binary",
  );
  await writeFileAt(join(archive, "Info.plist"), "<plist/>");
  return archive;
}

const names = (bundles: { name: string }[]) =>
  bundles.map((bundle) => bundle.name);

describe("collect", () => {
  test("finds the bundles inside an archive", async () => {
    await makeArchive();
    const found = await collect(join(root, "build", "*.xcarchive"));
    expect(names(found.bundles).sort()).toEqual([
      "MyApp.app.dSYM",
      "Widget.appex.dSYM",
    ]);
    expect(found.zips).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  test("takes a .dSYM path as a bundle", async () => {
    const bundle = await makeBundle(root, "Direct.framework.dSYM");
    const found = await collect(bundle);
    expect(found.bundles).toMatchObject([
      {
        name: "Direct.framework.dSYM",
        path: bundle,
        infoPlist: { path: join(bundle, "Contents", "Info.plist") },
        dwarfFiles: [{ name: "Direct" }],
      },
    ]);
  });

  test("uploads a matched zip as it is", async () => {
    const zip = join(root, "fastlane", "MyApp.app.dSYM.zip");
    await writeFileAt(zip, "zip bytes");
    const found = await collect(join(root, "fastlane", "*.zip"));
    expect(found).toEqual({
      bundles: [],
      zips: [{ path: zip, filename: "MyApp.app.dSYM.zip" }],
    });
  });

  test("walks nested matches once and ignores other files inside matched folders", async () => {
    await makeArchive();
    await writeFileAt(join(root, "build", "notes.txt"), "notes");
    await writeFileAt(join(root, "build", "artifacts.zip"), "zip");
    const found = await collect(
      `${join(root, "build", "**")}\n${join(root, "build")}`,
    );
    expect(names(found.bundles).sort()).toEqual([
      "MyApp.app.dSYM",
      "Widget.appex.dSYM",
    ]);
    expect(found.zips.map((zip) => zip.filename)).toEqual(["artifacts.zip"]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  test("counts a bundle reached by two patterns once", async () => {
    const archive = await makeArchive();
    const found = await collect(
      [
        archive,
        join(archive, "dSYMs", "*.dSYM"),
        join(root, "**", "MyApp.app.dSYM"),
      ].join("\n"),
    );
    expect(names(found.bundles).sort()).toEqual([
      "MyApp.app.dSYM",
      "Widget.appex.dSYM",
    ]);
  });

  test("honors exclude patterns", async () => {
    const archive = await makeArchive();
    const found = await collect(
      `${join(archive, "dSYMs", "*.dSYM")}\n!${join(archive, "dSYMs", "Widget.appex.dSYM")}`,
    );
    expect(names(found.bundles)).toEqual(["MyApp.app.dSYM"]);
  });

  test("warns about a matched file that is not a zip", async () => {
    const file = join(root, "MyApp.ipa");
    await writeFile(file, "ipa");
    const found = await collect(file);
    expect(found).toEqual({ bundles: [], zips: [] });
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("not a .dSYM bundle"),
    );
  });

  test("skips a bundle without DWARF", async () => {
    await mkdir(join(root, "Empty.dSYM", "Contents", "Resources"), {
      recursive: true,
    });
    const found = await collect(join(root, "Empty.dSYM"));
    expect(found.bundles).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("DEBUG_INFORMATION_FORMAT=dwarf-with-dsym"),
    );
  });

  test("follows a linked bundle but not linked folders", async () => {
    const elsewhere = await makeBundle(
      join(root, "elsewhere"),
      "Linked.app.dSYM",
    );
    const folder = join(root, "products");
    await mkdir(folder);
    await symlink(elsewhere, join(folder, "Linked.app.dSYM"));
    // A link back up the tree would loop forever if folder links were followed.
    await symlink(root, join(folder, "loop"));
    const found = await collect(folder);
    expect(found.bundles.map((bundle) => bundle.path)).toEqual([elsewhere]);
  });

  test("returns nothing for a pattern that matches nothing", async () => {
    expect(await collect(join(root, "missing", "*.xcarchive"))).toEqual({
      bundles: [],
      zips: [],
    });
  });

  test("collects the fixture zip", async () => {
    const found = await collect(FIXTURE_ZIP);
    expect(found.zips).toEqual([
      { path: await realpath(FIXTURE_ZIP), filename: "CrashDemo.dSYM.zip" },
    ]);
  });
});

describe("readBundle", () => {
  test("keeps Info.plist and the DWARF files, reading file links through", async () => {
    const bundle = await makeBundle(root, "App.app.dSYM", {
      dwarf: { App: "arm64 and x86_64", ".hidden": "skip" },
    });
    const target = join(root, "Extension");
    await writeFile(target, "extension DWARF");
    await symlink(
      target,
      join(bundle, "Contents", "Resources", "DWARF", "Extension"),
    );
    await writeFileAt(
      join(
        bundle,
        "Contents",
        "Resources",
        "Relocations",
        "aarch64",
        "App.yml",
      ),
      "relocations",
    );
    const read = await readBundle(bundle);
    expect(read).toMatchObject({
      name: "App.app.dSYM",
      dwarfFiles: [
        { name: "App", sizeBytes: 16 },
        { name: "Extension", sizeBytes: 15 },
      ],
      infoPlist: { path: join(bundle, "Contents", "Info.plist") },
    });
    expect(read!.sizeBytes).toBe(16 + 15 + read!.infoPlist!.sizeBytes);
  });

  test("allows a bundle without Info.plist", async () => {
    const bundle = await makeBundle(root, "NoPlist.dSYM", { plist: null });
    expect(await readBundle(bundle)).toMatchObject({ infoPlist: null });
  });
});
