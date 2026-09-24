import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import {
  FIXTURE_ZIP,
  extractFixture,
  makeBundle,
  readOutputs,
  temporaryDirectory,
} from "../test/helpers.js";
import { startMockServer, type MockServer } from "../test/mock-server.js";
import { run } from "./main.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  debug: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

const core = await import("@actions/core");

let summaryPath: string;
let outputPath: string;
let root: string;
let server: MockServer;

beforeAll(async () => {
  // core.summary remembers the first path it writes to, so every test shares one file.
  summaryPath = join(await temporaryDirectory(), "summary.md");
});

beforeEach(async () => {
  root = await temporaryDirectory();
  outputPath = join(root, "output.txt");
  await writeFile(outputPath, "");
  await writeFile(summaryPath, "");
  server = await startMockServer({
    requiredHeaders: { "CF-Access-Client-Id": "id.access" },
  });
  vi.stubEnv("GITHUB_OUTPUT", outputPath);
  vi.stubEnv("GITHUB_STEP_SUMMARY", summaryPath);
  vi.stubEnv("RUNNER_TEMP", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await server.close();
});

function inputs(values: Record<string, string>) {
  const all = {
    url: server.url,
    api_key: "aide_test",
    headers: "CF-Access-Client-Id: id.access",
    chunk_size: "1",
    project_name: "bludesign/app",
    build_id: "42",
    build_url: "https://github.com/bludesign/app/actions/runs/42",
    ...values,
  };
  for (const [name, value] of Object.entries(all)) {
    vi.stubEnv(`INPUT_${name.toUpperCase()}`, value);
  }
}

async function archive(): Promise<string> {
  const path = join(root, "build", "MyApp.xcarchive");
  await extractFixture(join(path, "dSYMs"));
  await makeBundle(join(path, "dSYMs"), "Widget.appex.dSYM");
  return path;
}

describe("run", () => {
  test("uploads an archive's dSYMs and a zip, and reports them", async () => {
    inputs({ dsym_paths: `${await archive()}\n${FIXTURE_ZIP}` });
    await run(new AbortController().signal);

    const outputs = await readOutputs(outputPath);
    const uploads = JSON.parse(outputs.uploads!);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({
      filename: "dSYMs.zip",
      duplicate: false,
    });
    expect(
      uploads[0].dsyms.map((dsym: { bundleName: string }) => dsym.bundleName),
    ).toEqual(["CrashDemo.dSYM", "Widget.appex.dSYM"]);
    expect(uploads[0].dsyms[0].url).toMatch(
      new RegExp(`^${server.url}/crashes/dsyms/`),
    );
    expect(uploads[1]).toMatchObject({
      filename: "CrashDemo.dSYM.zip",
      sizeBytes: 5918,
    });
    // CrashDemo is in both zips with the same DWARF, so its UUID is listed once.
    expect(outputs.uuids!.split("\n")).toHaveLength(2);

    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("<h3>dSYMs uploaded</h3>");
    expect(summary).toContain(">Widget.appex.dSYM</a>");
    expect(
      server.requests.every(
        (request) => request.headers["cf-access-client-id"],
      ),
    ).toBe(true);
    expect(core.warning).not.toHaveBeenCalled();
  });

  test("a dry run zips without contacting the server", async () => {
    inputs({
      dsym_paths: await archive(),
      dry_run: "true",
      url: "",
      api_key: "",
    });
    await run(new AbortController().signal);

    expect(server.requests).toEqual([]);
    expect(await readOutputs(outputPath)).toEqual({ uploads: "[]", uuids: "" });
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("dSYMs found (dry run)");
    expect(summary).toContain("CrashDemo.dSYM<br>Widget.appex.dSYM");
  });

  test.each([
    ["error", "No dSYMs matched dsym_paths. Check the paths"],
    ["warn", null],
    ["ignore", null],
  ])("if_no_files_found=%s", async (behavior, message) => {
    inputs({
      dsym_paths: join(root, "missing", "*.xcarchive"),
      if_no_files_found: behavior,
    });
    const result = run(new AbortController().signal);
    if (message) await expect(result).rejects.toThrow(message);
    else await expect(result).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledTimes(behavior === "warn" ? 1 : 0);
    expect(server.requests).toEqual([]);
  });

  test("keeps going after a failed zip and fails at the end", async () => {
    const junk = join(root, "junk.zip");
    await writeFile(junk, "not a zip");
    inputs({ dsym_paths: `${junk}\n${FIXTURE_ZIP}` });
    await expect(run(new AbortController().signal)).rejects.toThrow(
      "1 of 2 zips failed to upload: junk.zip",
    );
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining("INVALID_DSYM_ARCHIVE"),
    );
    const uploads = JSON.parse((await readOutputs(outputPath)).uploads!);
    expect(
      uploads.map((upload: { filename: string }) => upload.filename),
    ).toEqual(["CrashDemo.dSYM.zip"]);
  });

  test("fails with the server's reason when the only zip fails", async () => {
    inputs({ dsym_paths: FIXTURE_ZIP, api_key: "aide_wrong" });
    await expect(run(new AbortController().signal)).rejects.toThrow(
      "The API key is invalid or inactive",
    );
  });

  test("warns when the server skipped a bundle's DWARF", async () => {
    const folder = join(root, "dSYMs");
    await makeBundle(folder, "Good.dSYM");
    await makeBundle(folder, "Broken.dSYM", {
      dwarf: { Broken: "NOT-MACHO text" },
    });
    inputs({ dsym_paths: folder });
    await run(new AbortController().signal);
    expect(core.warning).toHaveBeenCalledWith(
      "The server indexed 1 of the 2 dSYMs in dSYMs.zip; it found no readable DWARF in Broken.dSYM.",
    );
  });

  test("suggests NODE_USE_ENV_PROXY when a proxy is set without it", async () => {
    inputs({ dsym_paths: FIXTURE_ZIP, dry_run: "true" });
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.com:3128");
    vi.stubEnv("NODE_USE_ENV_PROXY", "");
    await run(new AbortController().signal);
    expect(core.notice).toHaveBeenCalledWith(
      expect.stringContaining("NODE_USE_ENV_PROXY: 1"),
    );
  });
});
