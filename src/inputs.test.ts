import { afterEach, describe, expect, test, vi } from "vitest";

import { MIB, parseOrigin, readInputs } from "./inputs.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  warning: vi.fn(),
  setSecret: vi.fn(),
}));

const core = await import("@actions/core");

function stubInputs(inputs: Record<string, string>) {
  for (const [name, value] of Object.entries(inputs)) {
    vi.stubEnv(`INPUT_${name.toUpperCase()}`, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("parseOrigin", () => {
  test.each([
    ["https://aide.example.com", "https://aide.example.com"],
    ["https://aide.example.com/", "https://aide.example.com"],
    ["  http://127.0.0.1:3000 ", "http://127.0.0.1:3000"],
  ])("accepts %j", (value, origin) => {
    expect(parseOrigin(value).origin).toBe(origin);
  });

  test.each([
    ["aide.example.com", "must be an absolute URL"],
    ["ftp://aide.example.com", "must start with https:// or http://"],
    ["https://user:pass@aide.example.com", "must not contain credentials"],
    ["https://aide.example.com/?x=1", "must not contain a query"],
    ["https://aide.example.com/api", "Leave out /api"],
    ["https://aide.example.com/api/dsyms", "Leave out /api"],
    ["https://example.com/aide", "without a path"],
  ])("rejects %j", (value, message) => {
    expect(() => parseOrigin(value)).toThrow(message);
  });
});

describe("readInputs", () => {
  test("applies defaults", () => {
    stubInputs({
      url: "https://aide.example.com",
      api_key: "aide_key",
      dsym_paths: "build/*.xcarchive",
    });
    expect(readInputs()).toEqual({
      origin: "https://aide.example.com",
      apiKey: "aide_key",
      patterns: "build/*.xcarchive",
      headers: {},
      metadata: { projectName: null, buildId: null, url: null },
      chunkBytes: 16 * MIB,
      retries: 5,
      timeoutMs: 120_000,
      ifNoFilesFound: "error",
      dryRun: false,
    });
  });

  test("reads every input", () => {
    stubInputs({
      url: "https://aide.example.com",
      api_key: "aide_key",
      dsym_paths: "a\nb",
      headers: "CF-Access-Client-Id: id\nCF-Access-Client-Secret: secret",
      project_name: " bludesign/app ",
      build_id: "42",
      build_url: "https://github.com/bludesign/app/actions/runs/42",
      chunk_size: "4",
      retries: "0",
      timeout: "30",
      if_no_files_found: "WARN",
      dry_run: "false",
    });
    expect(readInputs()).toMatchObject({
      headers: {
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      },
      metadata: {
        projectName: "bludesign/app",
        buildId: "42",
        url: "https://github.com/bludesign/app/actions/runs/42",
      },
      chunkBytes: 4 * MIB,
      retries: 0,
      timeoutMs: 30_000,
      ifNoFilesFound: "warn",
    });
  });

  test("a dry run needs neither url nor api_key", () => {
    stubInputs({ dsym_paths: "build", dry_run: "true" });
    expect(readInputs()).toMatchObject({
      origin: null,
      apiKey: null,
      dryRun: true,
    });
  });

  test("an upload needs url and api_key", () => {
    stubInputs({ dsym_paths: "build", api_key: "aide_key" });
    expect(() => readInputs()).toThrow("Input required and not supplied: url");
    stubInputs({ url: "https://aide.example.com", api_key: "" });
    expect(() => readInputs()).toThrow(
      "Input required and not supplied: api_key",
    );
  });

  test("needs at least one path", () => {
    stubInputs({
      url: "https://aide.example.com",
      api_key: "k",
      dsym_paths: " \n ",
    });
    expect(() => readInputs()).toThrow("dsym_paths");
  });

  test.each([
    ["chunk_size", "17", "chunk_size must be a whole number from 1 to 16"],
    ["chunk_size", "1.5", "chunk_size must be a whole number"],
    ["retries", "11", "retries must be a whole number from 0 to 10"],
    ["timeout", "5", "timeout must be a whole number from 10 to 600"],
    [
      "if_no_files_found",
      "fail",
      "if_no_files_found must be error, warn, or ignore",
    ],
    ["dry_run", "maybe", "dry_run must be true or false"],
    [
      "project_name",
      "x".repeat(201),
      "project_name must be at most 200 characters",
    ],
    ["build_url", "not a url", "build_url must be an absolute URL"],
    ["build_url", "ftp://example.com/run", "build_url must use http or https"],
  ])("rejects %s=%j", (name, value, message) => {
    stubInputs({
      url: "https://aide.example.com",
      api_key: "aide_key",
      dsym_paths: "build",
      [name]: value,
    });
    expect(() => readInputs()).toThrow(message);
  });

  test("masks the key and header values only inside a runner", () => {
    stubInputs({
      url: "https://aide.example.com",
      api_key: "aide_key",
      dsym_paths: "build",
      headers: "X-Long: long-secret\nX-Short: 1",
    });
    // CI runs these tests on a runner, which sets GITHUB_ACTIONS itself.
    vi.stubEnv("GITHUB_ACTIONS", undefined);
    readInputs();
    expect(core.setSecret).not.toHaveBeenCalled();

    vi.stubEnv("GITHUB_ACTIONS", "true");
    readInputs();
    expect(vi.mocked(core.setSecret).mock.calls).toEqual([
      ["aide_key"],
      ["long-secret"],
    ]);
  });

  test("warns about plain http outside loopback", () => {
    stubInputs({
      url: "http://aide.example.com",
      api_key: "k",
      dsym_paths: "b",
    });
    readInputs();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("unencrypted"),
    );

    vi.mocked(core.warning).mockClear();
    stubInputs({ url: "http://localhost:3000" });
    readInputs();
    expect(core.warning).not.toHaveBeenCalled();
  });
});
