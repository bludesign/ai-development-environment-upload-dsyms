import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // GitHub's runners are slow enough that tests finishing well under a second
    // locally can trip Vitest's 5s default. Matches the app repo.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Transformed rather than loaded as-is, so tests that mock @actions/core
    // also silence the logging @actions/glob does through it.
    server: { deps: { inline: ["@actions/glob"] } },
  },
});
