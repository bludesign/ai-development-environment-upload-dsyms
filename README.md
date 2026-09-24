<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/logo-light.svg">
    <img src=".github/assets/logo-light.svg" alt="AI Development Environment" width="296">
  </picture>
</p>

<p align="center">A GitHub Action that uploads iOS and macOS dSYMs to an AI Development Environment control plane, so its crash reports are symbolicated.</p>

<p align="center">
  <a href="https://ai-development-environment.mintlify.app/debugging/upload-dsyms-action">Documentation</a> ·
  <a href="https://ai-development-environment.mintlify.app/debugging/dsyms">dSYMs</a> ·
  <a href="https://github.com/bludesign/ai-development-environment">AI Development Environment</a> ·
  <a href="https://github.com/bludesign/ai-development-environment-upload-dsyms/issues">Issues</a>
</p>

The action finds `.dSYM` bundles, zips them, and uploads them through the control plane's resumable upload in requests of at most 16 MiB. Uploads pass Cloudflare's 100 MB request limit, resume after a dropped connection, and outlast Cloudflare's 125-second timeout while the control plane indexes them. Extra headers, such as Cloudflare Access service-token headers, go on every request. It runs on macOS and Linux runners and does not need Xcode.

## Usage

Create an API key under **System → API Keys** in the dashboard. Add it to the repository as the `AIDE_API_KEY` secret, and add the control plane's address as the `AIDE_URL` variable. Then upload after archiving:

```yaml
- name: Archive
  run: |
    xcodebuild archive -scheme MyApp -configuration Release \
      -destination 'generic/platform=iOS' \
      -archivePath "$RUNNER_TEMP/MyApp.xcarchive"

- name: Upload dSYMs
  uses: bludesign/ai-development-environment-upload-dsyms@v1
  with:
    url: ${{ vars.AIDE_URL }}
    api_key: ${{ secrets.AIDE_API_KEY }}
    dsym_paths: ${{ runner.temp }}/MyApp.xcarchive
```

The dSYMs are recorded with the repository as their project, the run ID as their build ID, and a link to the run. Crashes that were waiting for them are symbolicated again automatically.

### fastlane

`build_app(include_symbols: true)` writes a `.app.dSYM.zip` next to the IPA. The action uploads a zip as it is:

```yaml
- name: Build with fastlane
  run: bundle exec fastlane beta # build_app(include_symbols: true, output_directory: "./build")

- name: Upload dSYMs
  uses: bludesign/ai-development-environment-upload-dsyms@v1
  with:
    url: ${{ vars.AIDE_URL }}
    api_key: ${{ secrets.AIDE_API_KEY }}
    dsym_paths: build/*.dSYM.zip
```

### Behind Cloudflare Access

When `/api/dsyms` is behind Cloudflare Access, send a service token's headers. See [Cloudflare Access](#cloudflare-access) for the policy it needs.

```yaml
- name: Upload dSYMs
  uses: bludesign/ai-development-environment-upload-dsyms@v1
  with:
    url: ${{ vars.AIDE_URL }}
    api_key: ${{ secrets.AIDE_API_KEY }}
    dsym_paths: ${{ runner.temp }}/MyApp.xcarchive
    headers: |
      CF-Access-Client-Id: ${{ secrets.CF_ACCESS_CLIENT_ID }}
      CF-Access-Client-Secret: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}
```

### Several paths

Each line of `dsym_paths` is a path or glob. Lines that start with `!` leave out what the other lines match, so match the bundles themselves when some should be left out:

```yaml
dsym_paths: |
  build/**/*.dSYM
  !build/**/*Tests*.dSYM
  vendor/Frameworks/*.dSYM.zip
```

### Outputs

```yaml
- name: Upload dSYMs
  id: dsyms
  uses: bludesign/ai-development-environment-upload-dsyms@v1
  with:
    url: ${{ vars.AIDE_URL }}
    api_key: ${{ secrets.AIDE_API_KEY }}
    dsym_paths: ${{ runner.temp }}/MyApp.xcarchive

- name: List the uploaded UUIDs
  env:
    UUIDS: ${{ steps.dsyms.outputs.uuids }}
  run: echo "$UUIDS"
```

### Dry run

`dry_run: true` finds and zips the dSYMs and logs each zip's size and sha256 without contacting the control plane, so `url` and `api_key` can be left out.

## Inputs

| Input               | Default                    | Description                                                                                                                                                                                          |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`               | Required                   | The control plane's origin, such as `https://aide.example.com`, without a path.                                                                                                                      |
| `api_key`           | Required                   | An API key (`aide_…`), sent as `X-API-Key`.                                                                                                                                                          |
| `dsym_paths`        | Required                   | Paths or globs, one per line: `.dSYM` bundles, folders that contain them (an `.xcarchive`, its `dSYMs` folder, build products), or `.zip` files of dSYMs. Lines that start with `!` exclude matches. |
| `headers`           | None                       | Extra headers sent with every request, one `Name: value` per line. Values are masked in the log. `Authorization`, `X-API-Key`, and the headers the upload sets itself are refused.                   |
| `project_name`      | `${{ github.repository }}` | Project shown on the dSYMs. Empty leaves it unset.                                                                                                                                                   |
| `build_id`          | `${{ github.run_id }}`     | Build ID shown on the dSYMs. Empty leaves it unset.                                                                                                                                                  |
| `build_url`         | The workflow run           | Link shown on the dSYMs. Empty leaves it unset.                                                                                                                                                      |
| `chunk_size`        | `16`                       | MiB per upload request, 1 to 16.                                                                                                                                                                     |
| `retries`           | `5`                        | Retries for each request after a network error, timeout, 408, 425, 429, or 5xx response.                                                                                                             |
| `timeout`           | `120`                      | Seconds to wait for each request, 10 to 600.                                                                                                                                                         |
| `if_no_files_found` | `error`                    | `error`, `warn`, or `ignore` when nothing matches.                                                                                                                                                   |
| `dry_run`           | `false`                    | Find and zip without uploading.                                                                                                                                                                      |

## Outputs

| Output    | Description                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploads` | JSON array with one entry per zip: `id`, `filename`, `sizeBytes`, `sha256`, `duplicate`, and `dsyms` with each dSYM's `id`, `bundleName`, `version`, `build`, dashboard `url`, and `slices` (`uuid`, `arch`). |
| `uuids`   | The uploaded UUIDs, one per line, as `xcrun dwarfdump --uuid` prints them.                                                                                                                                    |

## How it works

1. **Find.** A matched `.dSYM` is a bundle. Any other matched folder is searched for `.dSYM` bundles, without following links to folders. A matched `.zip` is uploaded unchanged.
2. **Zip.** The bundles go into `dSYMs.zip` with what the control plane keeps: each bundle's `Contents/Info.plist` and the files in `Contents/Resources/DWARF`. Links are stored as the files they point to, because the control plane refuses links in a zip. Timestamps and permissions are fixed, so uploading the same dSYMs again makes the same zip, which the control plane stores once. More than 500 bundles or 19 GiB are split across `dSYMs-2.zip` and so on.
3. **Upload.** Each zip is started with `POST /api/dsyms/uploads`, sent in `PATCH` chunks with an `Upload-Offset`, and finished with `POST /api/dsyms/uploads/{id}/complete`, which checks the zip's sha256 and indexes it. Failed requests are retried with exponential backoff, honoring `Retry-After`. After a failure the action asks the server for its offset, so a chunk that arrived without its answer is not sent twice.
4. **Wait for indexing.** Indexing a large zip can take longer than a proxy waits. Cloudflare answers 524 after 125 seconds while the control plane keeps working. The action then asks again, which waits for the indexing in progress and returns its result, for up to an hour.
5. **Report.** The log and the job summary list each dSYM with its UUIDs and a link. A zip that was uploaded before is reported as a duplicate of that upload. When one zip fails, the others are still uploaded and the step fails at the end. A failed or cancelled upload deletes its unfinished upload on the server.

## Cloudflare and other proxies

| Limit                                                    | What the action does                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| Request body: 100 MB on Free and Pro, 200 MB on Business | Sends at most `chunk_size` MiB per request, 16 by default          |
| 524 after 125 seconds                                    | Keeps chunks small, and asks again while the control plane indexes |
| 520 to 527, 530, and 502 to 504                          | Retries, resuming from the control plane's offset                  |
| 429 with `Retry-After`                                   | Waits as long as it asks, up to two minutes                        |

### Cloudflare Access

The [hosting guide](https://ai-development-environment.mintlify.app/reference/hosting#cloudflare-access-paths) bypasses Access for `/api/dsyms` and `/api/dsyms/uploads/*`, because the control plane checks the API key itself. To keep those paths behind Access instead:

1. Create a [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) in Cloudflare Zero Trust, and store its client ID and secret as the `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` secrets.
2. Give the Access application that covers the control plane a policy with the **Service Auth** action that includes the token.
3. Pass both headers in `headers`, as in [Behind Cloudflare Access](#behind-cloudflare-access).

Without valid headers, Access answers with a redirect to its sign-in page, or a 401. The action never follows redirects, so the API key is not sent anywhere else, and it fails with a hint about the headers.

### Bot protection

Bot Fight Mode, Super Bot Fight Mode, and WAF rules that issue challenges can answer CI with a challenge it cannot pass. The action reports the challenge (`cf-mitigated: challenge`) instead of retrying it. Super Bot Fight Mode and challenge rules can be skipped for `/api/dsyms*` with a WAF custom rule's **Skip** action. Bot Fight Mode on the Free plan cannot be skipped, so it has to be off for the zone.

### Other proxies

- nginx refuses request bodies over 1 MB unless `client_max_body_size` allows more. Set `client_max_body_size 16m;` for the control plane, or lower `chunk_size`.
- A proxy that times out during indexing, such as nginx's 60-second `proxy_read_timeout`, is handled like Cloudflare's 524. The action asks again after a 504.
- Node.js sends requests through `HTTPS_PROXY` and `HTTP_PROXY` only when `NODE_USE_ENV_PROXY` is `1`. On a runner behind an outbound proxy, set it in the step's `env`, and the action honors `NO_PROXY` too.
- For a control plane with a certificate from a private certificate authority, set `NODE_EXTRA_CA_CERTS` in the step's `env` to the path of that authority's certificate.

## Troubleshooting

| The log says                            | What to do                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `The API key is invalid or inactive`    | Check the `AIDE_API_KEY` secret against **System → API Keys**.                                                      |
| `Cloudflare Access stopped the request` | Pass the service token's headers, and check the Access application's **Service Auth** policy.                       |
| `Cloudflare answered with a challenge`  | Skip the rule that issued it for `/api/dsyms*`, or turn off Bot Fight Mode.                                         |
| `Cloudflare blocked the request`        | A WAF rule, IP access rule, or Access policy refused the runner. Search the Ray ID in Cloudflare's security events. |
| `refused the request body as too large` | Raise the proxy's body limit to 16 MiB, or lower `chunk_size`.                                                      |
| `The server redirected to …`            | Set `url` to the address the control plane answers on, such as `https://` rather than `http://`.                    |
| `No dSYMs matched dsym_paths`           | Check the paths against the build output. Set `if_no_files_found` to `warn` or `ignore` for builds that have none.  |
| `it has no DWARF files`                 | Build with `DEBUG_INFORMATION_FORMAT=dwarf-with-dsym`.                                                              |
| `The server indexed 1 of the 2 dSYMs`   | The control plane could not read a DWARF file as Mach-O.                                                            |
| `The server stopped indexing upload`    | The control plane restarted while indexing. Run the step again.                                                     |
| `The server could not index`            | **Uploads in progress** on the dSYMs page shows the reason.                                                         |

## Development

```bash
npm ci
npm run full-check
```

The runner executes `dist/index.js` without installing anything, so rebuild it with `npm run build` and commit it with every source change. CI fails when it is out of date. `node test/mock-server.ts --flaky` starts a stand-in for the control plane that drops and delays responses the way a proxy does.

To release, tag the commit and move the major version tag:

```bash
git tag v1.0.0
git tag -f v1
git push origin v1.0.0
git push -f origin v1
```

## License

MIT. See [`LICENSE.md`](LICENSE.md).
