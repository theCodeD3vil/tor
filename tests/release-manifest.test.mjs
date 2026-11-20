import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { signatureProblems } from "../.github/scripts/app-signature.mjs";
import {
  CI_LOGIN,
  assetNames,
  buildManifest,
  isLegacyRelease,
  publishedProblems,
  releaseProblems,
  releaseVersion,
  sha256,
  verifyManifest,
} from "../.github/scripts/release-manifest.mjs";
import { cleanNotes, notesProblems } from "../.github/scripts/release-notes.mjs";

const version = "0.1.14";
const repo = "example/tor";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pin = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
const config = {
  version,
  update: {
    url: `https://github.com/${repo}/releases/latest/download/manifest.json`,
    publicKey: pin,
  },
};

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "tor-release-test-"));
  try {
    const assets = assetNames(version).map((name, id) => {
      const path = join(dir, name);
      writeFileSync(path, name);
      return {
        id,
        name,
        digest: `sha256:${sha256(path)}`,
        size: name.length,
        uploader: { login: CI_LOGIN },
      };
    });
    const release = { tag_name: `v${version}`, draft: true, author: { login: CI_LOGIN }, assets };
    const manifest = buildManifest(config, repo, dir, "Release notes");
    run(release, manifest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const signFixture = (manifest) => {
  const format = "tinyjs-update-v1";
  const payload = JSON.stringify(manifest);
  const signature = sign(null, Buffer.from(`${format}\n${payload}`), privateKey).toString("base64");
  return { ...manifest, signed: { format, algorithm: "Ed25519", payload, signature } };
};

test("release version validation checks the entire JSON value", () => {
  for (const value of ["0.1.14\n", "0.1.14\r\nother=x", "0.01.14", "v0.1.14", 14])
    expect(() => releaseVersion(value)).toThrow();
  expect(releaseVersion(version)).toBe(version);
});

test("CI builds an unsigned draft for both final URLs, with their hashes", () =>
  fixture((draft, manifest) => {
    expect(manifest.signed).toBeUndefined();
    expect(releaseProblems(draft, manifest, repo, version, { draft: true, signed: false })).toEqual(
      [],
    );
    expect(manifest.mac.arm64.url).toBe(
      `https://github.com/${repo}/releases/download/v${version}/tor-${version}-macos-arm64.zip`,
    );
    expect(manifest.sha256).toBe(manifest.mac.arm64.sha256);
    expect(manifest.mac.x86_64.sha256).not.toBe(manifest.mac.arm64.sha256);
  }));

test("unexpected files, non-CI files, and a bad architecture mapping fail draft validation", () =>
  fixture((draft, manifest) => {
    draft.assets[1].uploader = { login: "owner" };
    draft.assets[2].name = "extra.dmg";
    manifest.mac.x86_64 = manifest.mac.arm64;
    const problems = releaseProblems(draft, manifest, repo, version, {
      draft: true,
      signed: false,
    }).join("\n");
    expect(problems).toContain("Unexpected, missing, or duplicate");
    expect(problems).toContain("was not uploaded by CI");
    expect(problems).toContain("x86_64 URL or hash");
  }));

test("published manifests must verify with a Tor key and match the legacy fields", () =>
  fixture((release, manifest) => {
    release.draft = false;
    release.assets.find((asset) => asset.name === "manifest.json").uploader = {
      login: "maintainer",
    };
    const signed = signFixture(manifest);
    expect(verifyManifest(signed, [pin])).toEqual(manifest);
    expect(publishedProblems(release, signed, repo, [pin])).toEqual([]);
    expect(publishedProblems(release, manifest, repo, [pin])).toHaveLength(1);
    expect(() => verifyManifest(signed, [Buffer.alloc(32).toString("base64")])).toThrow(
      /pinned Tor key/,
    );
    expect(() => verifyManifest({ ...signed, notes: "Different notes" }, [pin])).toThrow(
      /fields differ/,
    );
  }));

test("legacy releases are exempt only if published before the cutoff and untouched", () => {
  const legacy = {
    tag_name: "v0.1.13",
    draft: false,
    published_at: "2026-11-18T12:18:26Z",
    assets: [{ name: "manifest.json", updated_at: "2026-11-18T12:18:25Z" }],
  };
  expect(isLegacyRelease(legacy)).toBe(true);
  expect(isLegacyRelease({ ...legacy, tag_name: "v0.0.1" })).toBe(true);
  expect(isLegacyRelease({ ...legacy, tag_name: "v0.0.2" })).toBe(false);
  expect(isLegacyRelease({ ...legacy, tag_name: "v0.1.14" })).toBe(false);
  expect(publishedProblems(legacy, null, repo, [pin])).toEqual([]);
  legacy.assets[0].updated_at = "2026-11-20T00:00:00Z";
  expect(publishedProblems(legacy, null, repo, [pin])).toHaveLength(1);
});

test("release notes drop template comments and permit ordinary HTTPS Markdown", () => {
  const notes = cleanNotes("New in Tor\n\n<!-- PR template -->\n\nA [guide](https://example.com).");
  expect(notes).toBe("New in Tor\n\nA [guide](https://example.com).");
  expect(notesProblems(notes)).toEqual([]);
  expect(notesProblems("A <b>label</b> and ![photo](https://example.com/photo.png).")).toEqual([
    "raw HTML",
    "an image",
  ]);
  expect(notesProblems("[Contact](mailto:info@example.com)")).toHaveLength(1);
});

test("macOS app signatures must use a certificate and the hardened runtime", () => {
  const signed =
    "CodeDirectory v=20500 flags=0x10000(runtime) hashes=2\nAuthority=Tor Code Signing";
  expect(signatureProblems("Tor", signed, "")).toEqual([]);
  expect(
    signatureProblems("Tor", "CodeDirectory v=20500 flags=0x2(adhoc)\nSignature=adhoc", ""),
  ).toHaveLength(2);
  expect(
    signatureProblems("Tor", signed, "<key>com.apple.security.get-task-allow</key>"),
  ).toHaveLength(1);
});
