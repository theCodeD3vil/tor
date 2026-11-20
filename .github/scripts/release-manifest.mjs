import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ARCHES = ["arm64", "x86_64"];
export const CI_LOGIN = "github-actions[bot]";
export const MANIFEST = "manifest.json";
export const UPDATE_KEY_REF = "op://Personal/Tor update signing key/password";
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const FORMAT = "tinyjs-update-v1";
// The newest release that shipped before Tor pinned its update key.
const LAST_LEGACY = "2026-11-18T12:18:26Z";

export function releaseVersion(version) {
  const match =
    typeof version === "string" && version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match || match[0] !== version)
    throw new Error("tinyjs.json version must be a single MAJOR.MINOR.PATCH string");
  return version;
}

export const readConfig = () => JSON.parse(readFileSync("tinyjs.json", "utf8"));
export const fileName = (version, arch, ext) => `tor-${version}-macos-${arch}.${ext}`;
export const assetNames = (version) => [
  MANIFEST,
  ...ARCHES.flatMap((arch) => ["zip", "dmg"].map((ext) => fileName(version, arch, ext))),
];
export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const jsonFile = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

export function repositoryOf(config = readConfig()) {
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/latest\/download\/manifest\.json$/.exec(
      config.update?.url,
    );
  if (!match || match[0] !== config.update?.url)
    throw new Error("tinyjs.json does not name a GitHub stable update channel");
  return match[1];
}

function strictBase64(value, size) {
  if (typeof value !== "string") throw new Error("Invalid Ed25519 encoding");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== value)
    throw new Error("Invalid Ed25519 encoding");
  return bytes;
}

export function publicKeys(config) {
  const pin = config.update?.publicKey;
  const keys = Array.isArray(pin) ? pin : [pin];
  if (!keys.length) throw new Error("No update public key is pinned");
  for (const key of keys) strictBase64(key, 32);
  return keys;
}

export function verifyManifest(doc, pins) {
  const signed = doc?.signed;
  if (
    !signed ||
    signed.format !== FORMAT ||
    signed.algorithm !== "Ed25519" ||
    typeof signed.payload !== "string" ||
    Object.keys(signed).sort().join(",") !== "algorithm,format,payload,signature"
  )
    throw new Error("The TinyJS manifest has no valid signature envelope");
  const signature = strictBase64(signed.signature, 64);
  const keys = publicKeys({ update: { publicKey: pins } }).map((pin) =>
    createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: strictBase64(pin, 32).toString("base64url") },
      format: "jwk",
    }),
  );
  if (
    !keys.some((key) => verify(null, Buffer.from(`${FORMAT}\n${signed.payload}`), key, signature))
  )
    throw new Error("The update manifest was not signed by a pinned Tor key");
  const payload = JSON.parse(signed.payload);
  const { signed: _signed, ...outer } = doc;
  // Legacy clients read the outer fields; these must be the signed fields too.
  if (jsonFile(payload) !== jsonFile(outer))
    throw new Error("The signed payload and legacy manifest fields differ");
  return payload;
}

export function buildManifest(config, repo, directory, notes) {
  const version = releaseVersion(config.version);
  publicKeys(config);
  if (repo !== repositoryOf(config))
    throw new Error("Update URL does not match the release repository");
  const mac = Object.fromEntries(
    ARCHES.map((arch) => {
      const name = fileName(version, arch, "zip");
      return [
        arch,
        { url: releaseUrl(repo, version, name), sha256: sha256(join(directory, name)) },
      ];
    }),
  );
  return { version, mac, ...mac.arm64, notes };
}

export const releaseUrl = (repo, version, name) =>
  `https://github.com/${repo}/releases/download/v${version}/${name}`;

function exactKeys(object, fields) {
  return (
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).length === fields.length &&
    fields.every((field) => Object.hasOwn(object, field))
  );
}

export function releaseProblems(release, manifest, repo, version, { draft, signed }) {
  const problems = [];
  if (release.tag_name !== `v${version}` || release.draft !== draft || release.prerelease)
    problems.push("The release tag, draft state, or channel is wrong");
  if (release.author?.login !== CI_LOGIN) problems.push("CI did not create this release");
  const expected = assetNames(version);
  if (
    release.assets.length !== expected.length ||
    expected.some((name) => release.assets.filter((asset) => asset.name === name).length !== 1)
  )
    problems.push("Unexpected, missing, or duplicate release assets");
  for (const asset of release.assets) {
    if ((!signed || asset.name !== MANIFEST) && asset.uploader?.login !== CI_LOGIN)
      problems.push(`${asset.name} was not uploaded by CI`);
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") || !(asset.size > 0))
      problems.push(`${asset.name} is missing its GitHub digest or size`);
  }
  if (
    !exactKeys(manifest, ["version", "mac", "url", "sha256", "notes"]) ||
    manifest.version !== version ||
    typeof manifest.notes !== "string" ||
    !exactKeys(manifest.mac, ARCHES)
  )
    return [...problems, "Unexpected manifest fields, version, or architectures"];
  for (const arch of ARCHES) {
    const name = fileName(version, arch, "zip");
    const entry = manifest.mac[arch];
    if (
      !exactKeys(entry, ["sha256", "url"]) ||
      entry.url !== releaseUrl(repo, version, name) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      release.assets.find((file) => file.name === name)?.digest !== `sha256:${entry.sha256}`
    )
      problems.push(`The ${arch} URL or hash does not match its release archive`);
  }
  if (manifest.url !== manifest.mac.arm64?.url || manifest.sha256 !== manifest.mac.arm64?.sha256)
    problems.push("The legacy download does not match the arm64 archive");
  return problems;
}

export function isLegacyRelease(release) {
  const match = /^v0\.1\.(0|[1-9]\d*)$/.exec(release.tag_name);
  return (
    (release.tag_name === "v0.0.1" ||
      (!!match && match[0] === release.tag_name && Number(match[1]) <= 13)) &&
    typeof release.published_at === "string" &&
    release.published_at <= LAST_LEGACY
  );
}

export function publishedProblems(release, doc, repo, pins) {
  if (release.draft) return [];
  if (isLegacyRelease(release))
    return release.assets
      .filter((asset) => asset.updated_at > LAST_LEGACY)
      .map((asset) => `${asset.name} changed after the legacy cutoff`);
  try {
    const version = releaseVersion(release.tag_name.slice(1));
    return releaseProblems(release, verifyManifest(doc, pins), repo, version, {
      draft: false,
      signed: true,
    });
  } catch (err) {
    return [String(err)];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "version") throw new Error("Usage: release-manifest.mjs version");
  console.log(releaseVersion(readConfig().version));
}
