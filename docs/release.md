# Releasing Melodic Studio

Pushing a tag like `v0.2.0` runs `.github/workflows/release.yml`, which builds installers on macOS, Windows and Linux, attaches them to a draft GitHub release, and publishes the release once all three have finished. It follows Tapedeck's setup.

## What a release contains

| Platform | Runner | Files |
|---|---|---|
| macOS (Apple silicon only, macOS 14+; Intel Macs are not supported from 0.4.1) | `macos-latest` | `.dmg`, `.app.tar.gz` |
| Windows (x64) | `windows-latest` | NSIS `-setup.exe`, `.msi` |
| Linux (x64) | `ubuntu-22.04` | `.deb`, `.rpm`, `.AppImage` |

## One-time setup

1. Put the repository on GitHub (the workflow only needs the default `GITHUB_TOKEN` to create releases).
2. Add the signing secrets under Settings → Secrets and variables → Actions. They are the same names and values Tapedeck uses.

   **macOS signing and notarization**

   | Secret | What it is |
   |---|---|
   | `APPLE_CERTIFICATE` | The Developer ID Application certificate, exported as `.p12` and base64-encoded |
   | `APPLE_CERTIFICATE_PASSWORD` | The password of that `.p12` |
   | `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
   | `APPLE_ID` | The Apple ID used for notarization |
   | `APPLE_PASSWORD` | An app-specific password for that Apple ID |
   | `APPLE_TEAM_ID` | The team id |

   **Windows signing (Azure Trusted Signing, through `scripts/sign-windows.mjs`)**

   | Secret | What it is |
   |---|---|
   | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | The service principal with the "Artifact Signing Certificate Profile Signer" role |
   | `TRUSTED_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` |
   | `TRUSTED_SIGNING_ACCOUNT` | The signing account name |
   | `TRUSTED_SIGNING_PROFILE` | The certificate profile name |

   **In-app updates (the updater key)**

   | Secret | What it is |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | The contents of `~/.tauri/melodic-studio.key` |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Leave unset: the key was generated without a password |

   The matching public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). **Keep the private key safe and backed up.** Installed copies only accept updates signed with it; if it is lost, nobody who has the app installed can ever update again, and they would have to download a new build by hand.

   Linux packages are not signed.

### Without the secrets

The workflow still builds. A platform whose secrets are missing is built unsigned, and without the updater key the build has no update archives or `latest.json`; the run shows a warning for each. Because an unsigned macOS download is blocked by Gatekeeper, an unsigned Windows installer triggers SmartScreen, and a release without `latest.json` is invisible to installed copies, **the release is then left as a draft** instead of being published; publish it by hand from the Releases page if you want it out anyway.

## How updates reach people

Each published release carries `latest.json` beside the installers. The installed app asks GitHub for `releases/latest/download/latest.json` a few seconds after launch and every four hours, downloads a newer version in the background, verifies it against the public key, and shows "Version X is ready · Restart to update" in the toolbar (also under Settings, with a "Check now" button). Only a **published, non-draft, latest** release is seen. Development builds never check.

The update address is `https://github.com/MelodicDevelopment/melodic-studio/...`; if the repository is named differently, change `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` before the first release, because already-installed copies keep the address they were built with.

## Before tagging

CI on pushes to `main` runs on Linux only. When a change touched platform code (paths, processes, the window), run
Actions → CI → Run workflow first: that is the full macOS / Windows / Linux check.

## Cutting a release

```sh
npm run bump -- set 0.2.0        # package.json, tauri.conf.json, Cargo.toml and both lock files
git commit -am "Short title of the release

What changed, as it should read on the release page."
git tag v0.2.0
git push && git push --tags
```

- The tag must equal the app version (`v` + the version); the workflow's first step fails otherwise.
- The release title is `Melodic Studio v0.2.0 — <subject of the tagged commit>` and its notes are that commit's body, so write the commit message for the people who will read the release page.
- `npm run bump` with no arguments prints the current version and fails if the three version files disagree.

## Trying the build without releasing

Actions → Release → Run workflow builds the same installers from any branch and attaches them to the workflow run as artifacts. No tag, no release.

Locally:

```sh
# Installers for the OS you are on, in src-tauri/target/release/bundle. Without the updater key:
npm run desktop:build -- --config src-tauri/tauri.no-updater.conf.json
# With it (also produces the signed update archive):
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/melodic-studio.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run desktop:build
# On Windows, add SKIP_WIN_SIGN=1 when the Azure signing secrets are not in the environment.
```

## Not set up yet

- **Linux on ARM, Windows on ARM.** One extra matrix row each when wanted.
