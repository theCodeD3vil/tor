# Tor release process

Tor follows Teneo’s macOS release process. GitHub can build and attest release files, but it cannot sign an update manifest. The private update key stays in Tor’s 1Password item.

## Releasing a version

1. Bump `version` in `tinyjs.json` in a PR. Its title and body become the release notes. The notes must be plain Markdown, with HTTPS links only. CI strips HTML comments and rejects raw HTML and images so older Tor installs can safely display the notes.
2. Merge into `main` and approve the GitHub `release` environment. CI uses checksum-pinned TinyJS v0.75.1 and Tor’s macOS certificate to build Apple Silicon and Intel packages with the hardened runtime. It attests both ZIPs, both DMGs, and the unsigned manifest, then creates a **draft**.
3. From a trusted checkout on the maintainer’s Mac, with `gh` signed in and the 1Password desktop CLI integration enabled:

   ```sh
   bun run release:publish --dry-run
   bun run release:publish                 # or: bun run release:publish 0.1.14
   ```

   The script verifies the draft’s provenance against the release workflow on `main` at its exact source commit. It checks the asset digests, the app signatures, and the manifest, then displays the full release notes. Type the version and approve 1Password with Touch ID. TinyJS signs the manifest locally; the script publishes the draft and checks the stable update channel. A dry run never reads the private key or changes GitHub.

Only the stable macOS channel is used. Tor has no Teneo Android or beta assets. A self-signed macOS certificate is not Apple notarization; first-time installation still uses the instructions in the README.

## One-time setup

- On GitHub, protect `main` and release tags, enable immutable releases and secret scanning, and set the `release` environment to **main only** with a required reviewer. Use `bun run release:github-settings --prepare` to set up only the environment. Use `--dry-run` to review all settings and `--apply` once the `Checks` workflow has run on the migration PR. These commands need a short-lived Tor-scoped administrative credential.
- Run `bun run release:certificate` to create Tor’s self-signed certificate and save it in the **Tor signing secrets** item in 1Password. If you already have a Tor certificate, create that item in the `Personal` vault with `MACOS_CERTIFICATE_P12` (base64 PKCS#12) and `MACOS_CERTIFICATE_PASSWORD` instead. After setting up the environment, run `bun run release:secrets`. These two values go into GitHub’s `release` **environment**, not repository-wide secrets. Do not reuse Teneo’s certificate.
- Import the existing Tor update key into **Tor update signing key** in 1Password with `bun run release:key --import /path/to/update-private.der`. The command checks that it matches `tinyjs.json`; it does not change the pin. The publisher defaults to `op://Personal/Tor update signing key/password`, or uses `TOR_UPDATE_KEY_REF` if set. Do not reuse Teneo’s key.
- **Remove `TINYJS_UPDATE_PRIVATE_KEY_B64` from GitHub if it was configured for the previous design.** A key previously shared with CI is not an offline trust anchor. If the old key may have been exposed, run `bun run release:key --replace-unreleased` before the first signed release. It checks the public release history first, creates a fresh key in 1Password, and updates the pin. Never replace a pin already shipped to users in place.
- On the maintainer’s Mac the release scripts use ordinary `gh` if authenticated, or Teneo’s 1Password shell-plugin pattern (`op plugin run -- gh`) otherwise. Set `TOR_GH=op` to select the plugin explicitly. Sign out after publishing if you used a separate `gh` login. Users on Tor 0.1.13 or earlier should upgrade manually from the official release page; those builds do not verify manifest signatures.

Run plugin-backed commands from an interactive terminal. If the usual plugin credential cannot manage environments and secrets, use a short-lived Tor admin credential stored in 1Password, with `GH_TOKEN` set to its **1Password reference**, not its value:

```sh
GH_TOKEN='op://Personal/YOUR_ADMIN_ITEM/credential' op run -- bun run release:github-settings --prepare
GH_TOKEN='op://Personal/YOUR_ADMIN_ITEM/credential' op run -- bun run release:secrets
```

For a planned rotation, `bun run release:key --rotate` stores a new key in a separate item and adds its public key alongside the current pin. Publish once with the old key so clients learn both, then switch `TOR_UPDATE_KEY_REF` to the new item. Keep a copy of public keys needed to verify previously published releases until the watchdog policy is updated for the rotation.

## Watchdog

GitHub runs the watchdog on release events and every 30 minutes. It checks signed manifests, their archive hashes and URLs, and CI ownership of the draft and packages. It also flags changes to pre-signing releases. If a release violates those checks, the watchdog attempts to return it to draft and opens an issue. If GitHub refuses to retract an immutable release, the watchdog reports it for manual review rather than deleting it automatically. An API or download failure alone never retracts a release.
