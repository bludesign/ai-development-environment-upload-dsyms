import * as core from "@actions/core";

import { CancelledError } from "./http.js";
import { run } from "./main.js";

// The runner sends SIGINT when a job is cancelled, then SIGTERM, then kills the
// process. Aborting stops the upload and lets it delete the unfinished upload.
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    core.warning(`Received ${signal}; cancelling the upload.`);
    controller.abort(
      new CancelledError(`The upload was cancelled by ${signal}`),
    );
  });
}

try {
  await run(controller.signal);
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
