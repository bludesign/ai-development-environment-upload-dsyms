import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "esbuild";

const manifest = JSON.parse(await readFile("package.json", "utf8"));

// The runner executes dist/index.js without installing anything, so every
// dependency is bundled. Kept readable (no minify) so dist diffs can be reviewed.
const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/index.js",
  legalComments: "none",
  metafile: true,
  define: { __VERSION__: JSON.stringify(manifest.version) },
  // Bundled CommonJS dependencies (yazl) still call require().
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);`,
  },
});

// The bundle carries third-party code, so it ships their license notices.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
  if (match) packages.set(match[1], match[2]);
}
const notices = [];
for (const [directory, name] of packages) {
  const pkg = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  const licenseFile = (await readdir(directory)).find((file) =>
    /^(licen[cs]e|copying)/i.test(file),
  );
  const text = licenseFile
    ? (await readFile(join(directory, licenseFile), "utf8")).trim()
    : `License: ${pkg.license ?? "unknown"}`;
  notices.push(`${name}@${pkg.version}\n\n${text}`);
}
notices.sort();
await writeFile(
  "dist/licenses.txt",
  `${notices.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
);
