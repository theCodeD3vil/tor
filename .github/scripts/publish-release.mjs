import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { assertApp } from "./app-signature.mjs";
import { listReleases, run } from "./release-command.mjs";
import {
  ARCHES,
  MANIFEST,
  RELEASE_WORKFLOW,
  UPDATE_KEY_REF,
  fileName,
  jsonFile,
  publicKeys,
  readConfig,
  releaseProblems,
  releaseVersion,
  repositoryOf,
  sha256,
  verifyManifest,
} from "./release-manifest.mjs";
import { assertNotes } from "./release-notes.mjs";

if (process.platform !== "darwin") throw new Error("Run release:publish on the maintainer's Mac");
const config = readConfig();
const repo = repositoryOf(config);
const pins = publicKeys(config);
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const versions = args.filter((arg) => arg !== "--dry-run");
if (versions.length > 1) throw new Error("Usage: release:publish [version] [--dry-run]");
const version = releaseVersion(versions[0] ?? config.version);
const tag = `v${version}`;

function getDraft() {
  const matches = listReleases(repo).filter((release) => release.tag_name === tag);
  if (matches.length !== 1 || !matches[0].draft)
    throw new Error(`Expected one unpublished ${tag} draft from CI`);
  const draft = matches[0];
  if (!/^[0-9a-f]{40}$/.test(draft.target_commitish))
    throw new Error("The draft is not pinned to a source commit");
  return draft;
}

function download(asset, path) {
  const fd = openSync(path, "wx", 0o600);
  try {
    run(
      "gh",
      [
        "api",
        "-H",
        "Accept: application/octet-stream",
        `repos/${repo}/releases/assets/${asset.id}`,
      ],
      { stdio: ["ignore", fd, "inherit"] },
    );
  } finally {
    closeSync(fd);
  }
  if (asset.digest !== `sha256:${sha256(path)}`)
    throw new Error(`${asset.name} did not match the GitHub asset digest`);
}

function attest(path, draft) {
  run("gh", [
    "attestation",
    "verify",
    path,
    "--repo",
    repo,
    "--signer-workflow",
    `${repo}/${RELEASE_WORKFLOW}`,
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    draft.target_commitish,
    "--deny-self-hosted-runners",
  ]);
}

function snapshot(release, omitManifest = false) {
  return JSON.stringify([
    release.id,
    release.target_commitish,
    release.name,
    release.body,
    release.assets
      .filter((asset) => !omitManifest || asset.name !== MANIFEST)
      .map(({ name, id, digest }) => [name, id, digest])
      .sort(),
  ]);
}

const temp = mkdtempSync(join(tmpdir(), "tor-release-"));
try {
  const draft = getDraft();
  const asset = draft.assets.find((entry) => entry.name === MANIFEST);
  if (!asset || !(asset.size > 0 && asset.size <= 256_000))
    throw new Error("Missing or oversized draft manifest");
  const manifestPath = join(temp, MANIFEST);
  download(asset, manifestPath);
  const document = JSON.parse(readFileSync(manifestPath, "utf8"));
  const alreadySigned = document?.signed !== undefined;
  const manifest = alreadySigned ? verifyManifest(document, pins) : document;
  const problems = releaseProblems(draft, manifest, repo, version, {
    draft: true,
    signed: alreadySigned,
  });
  if (problems.length) throw new Error(problems.join("\n"));
  assertNotes(manifest.notes);
  if (draft.body?.trim() !== manifest.notes.trim())
    throw new Error("GitHub's release notes do not match the manifest");

  // Resume an interrupted publish only if the signed payload is exactly the
  // CI-attested plain manifest. package-release.mjs writes it as jsonFile().
  const plain = alreadySigned ? join(temp, "ci-manifest.json") : manifestPath;
  if (alreadySigned) writeFileSync(plain, jsonFile(manifest));
  attest(plain, draft);
  for (const arch of ARCHES) {
    for (const ext of ["zip", "dmg"]) {
      const name = fileName(version, arch, ext);
      const path = join(temp, name);
      download(
        draft.assets.find((entry) => entry.name === name),
        path,
      );
      attest(path, draft);
      if (ext === "zip") {
        const unpacked = mkdtempSync(join(temp, "app-"));
        run("/usr/bin/ditto", ["-x", "-k", path, unpacked]);
        assertApp(join(unpacked, `${config.title}.app`), { ...config, version }, arch);
      }
    }
  }

  console.log(`\nTor ${version}, built from main at ${draft.target_commitish}:`);
  for (const file of draft.assets) console.log(`  ${file.name}  ${file.digest}`);
  console.log(`\nRelease notes:\n${manifest.notes}\n`);
  if (dryRun) {
    console.log("Dry run: provenance and signatures verified. Nothing was signed or published.");
  } else {
    if (!process.stdin.isTTY) throw new Error("Publishing requires an interactive terminal");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt
      .question(`Type ${version} to sign and publish: `)
      .finally(() => prompt.close());
    if (answer.trim() !== version) throw new Error("Nothing was published");
    if (snapshot(getDraft()) !== snapshot(draft))
      throw new Error("The draft changed after verification");

    if (!alreadySigned) {
      const localTinyjs = join(homedir(), ".tinyjs", "tinyjs");
      const tinyjs = existsSync(localTinyjs) ? localTinyjs : "tinyjs";
      if (!run(tinyjs, ["version"]).startsWith("tinyjs v0.75.1 "))
        throw new Error("Install TinyJS v0.75.1, the version CI builds with");
      const reference = process.env.TOR_UPDATE_KEY_REF ?? UPDATE_KEY_REF;
      if (!reference.startsWith("op://"))
        throw new Error("TOR_UPDATE_KEY_REF must be a 1Password reference");
      console.log("Reading Tor's update key from 1Password. Approve with Touch ID.");
      const keyFile = join(temp, "update-key.der");
      const key = Buffer.from(run("op", ["read", "--no-newline", reference]).trim(), "base64");
      if (!key.length) throw new Error("The 1Password entry holds no update key");
      try {
        writeFileSync(keyFile, key, { mode: 0o600 });
        key.fill(0);
        const { HOME, PATH, TMPDIR } = process.env;
        run(tinyjs, ["publish", "--sign-manifest", manifestPath], {
          env: { HOME, PATH, TMPDIR, TINYJS_UPDATE_PRIVATE_KEY_FILE: keyFile },
        });
      } finally {
        rmSync(keyFile, { force: true });
      }
      const payload = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")), pins);
      if (jsonFile(payload) !== jsonFile(manifest))
        throw new Error("The signed manifest differs from CI's");
      if (snapshot(getDraft()) !== snapshot(draft))
        throw new Error("The draft changed during signing");
      run("gh", ["release", "upload", tag, manifestPath, "--clobber", "--repo", repo]);
    }
    const ready = getDraft();
    if (
      snapshot(ready, true) !== snapshot(draft, true) ||
      ready.assets.find((file) => file.name === MANIFEST)?.digest !==
        `sha256:${sha256(manifestPath)}`
    )
      throw new Error("The draft changed before publication");
    run("gh", ["release", "edit", tag, "--draft=false", "--latest", "--repo", repo]);
    let live;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const response = await fetch(config.update.url, { signal: AbortSignal.timeout(15000) });
        if (response.ok) live = verifyManifest(await response.json(), pins);
        if (live && jsonFile(live) === jsonFile(manifest)) break;
      } catch {
        // GitHub's latest URL can take a moment to switch.
      }
    }
    if (!live || jsonFile(live) !== jsonFile(manifest))
      throw new Error("Published, but the stable channel has not returned this signed manifest");
    for (const { url } of Object.values(live.mac)) {
      const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Published, but ${url} returned ${response.status}`);
    }
    console.log(`Tor ${version} is published and the signed update is live.`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
