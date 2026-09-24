import { describe, expect, test } from "vitest";

import { parseHeaderLine, parseHeaders } from "./headers.js";

describe("parseHeaders", () => {
  test("reads one Name: value per line and skips blank lines", () => {
    expect(
      parseHeaders(
        "CF-Access-Client-Id: abc.access\n\n  CF-Access-Client-Secret:  s3cr3t:with:colons  \r\n",
      ),
    ).toEqual({
      "CF-Access-Client-Id": "abc.access",
      "CF-Access-Client-Secret": "s3cr3t:with:colons",
    });
  });

  test("keeps the last value of a repeated name in any case", () => {
    expect(parseHeaders("X-Team: one\nx-team: two")).toEqual({
      "x-team": "two",
    });
  });

  test("returns nothing for an empty input", () => {
    expect(parseHeaders("")).toEqual({});
  });

  test.each([
    [
      "Authorization: Bearer token",
      /Authorization header cannot be set.*credential/,
    ],
    ["X-API-Key: aide_key", /pass the API key in api_key/],
    ["content-length: 12", /content-length header cannot be set/],
    ["Upload-Offset: 0", /Upload-Offset header cannot be set/],
    ["Host: example.com", /Host header cannot be set/],
  ])("refuses %s", (line, message) => {
    expect(() => parseHeaders(line)).toThrow(message);
  });

  test.each([
    ["no separator", 'must use the format "Name: value"'],
    [": value", 'must use the format "Name: value"'],
    ["Bad Name: value", "Invalid HTTP header name: Bad Name"],
    ["X-Empty:", "Invalid value for HTTP header X-Empty"],
    ["X-Control: a\u0000b", "Invalid value for HTTP header X-Control"],
  ])("rejects %j", (line, message) => {
    expect(() => parseHeaderLine(line)).toThrow(message);
  });
});
