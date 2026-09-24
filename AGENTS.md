# Agent notes

This repository is a GitHub Action that uploads dSYMs to an AI Development Environment control plane through its resumable upload endpoints (`/api/dsyms/uploads`, implemented in `bludesign/ai-development-environment`).

- `dist/index.js` is what the runner executes. After changing `src/`, run `npm run build` and commit `dist/` with the change; CI fails when it is out of date.
- `npm run full-check` formats, lints, type-checks, tests, and builds.
- `test/mock-server.ts` mirrors the control plane's upload endpoints and injects proxy failures. CI runs it with `node test/mock-server.ts`, under Node's type stripping, so keep it to erasable TypeScript without relative imports, and keep it in step with the server when the upload contract changes.
- Inputs are snake_case, like `DataDog/upload-dsyms-github-action`. Document input changes in `action.yml`, `README.md`, and the docs site's `debugging/upload-dsyms-action.mdx` (`bludesign/ai-development-environment-docs`).
- Commit messages start with the Jira ticket, such as `[AIDE-140] Summary`.
