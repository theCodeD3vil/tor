import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { run } from "./release-command.mjs";
import { isLegacyRelease, readConfig, repositoryOf } from "./release-manifest.mjs";

const args = process.argv.slice(2);
let vault = "Personal";
let importing;
let rotate = false;
let replaceUnreleased = false;
while (args.length) {
  const flag = args.shift();
  if (flag === "--rotate") rotate = true;
  else if (flag === "--replace-unreleased") replaceUnreleased = true;
  else if (flag === "--vault" && args[0] && !args[0].startsWith("--")) vault = args.shift();
  else if (flag === "--import" && args[0] && !args[0].startsWith("--")) importing = args.shift();
  else
    throw new Error(
      "Usage: release:key [--vault NAME] [--import PKCS8_DER_FILE | --rotate | --replace-unreleased]",
    );
}
const config = readConfig();
const pinned = [config.update?.publicKey ?? []].flat();
if ([rotate, !!importing, replaceUnreleased].filter(Boolean).length > 1)
  throw new Error("Pick only one key operation");
if (
  (rotate && pinned.length !== 1) ||
  (!rotate && !importing && !replaceUnreleased && pinned.length)
)
  throw new Error("A key is already pinned. Import its matching key or begin a rotation.");
if (importing && !pinned.length) throw new Error("Import requires the matching key to be pinned");

if (replaceUnreleased) {
  // This is only for the first signed version, never for replacing a shipped pin.
  const repository = repositoryOf(config);
  let url = `https://api.github.com/repos/${repository}/releases?per_page=100`;
  let found = false;
  while (url) {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Could not verify public release history");
    const releases = await response.json();
    found ||= releases.length > 0;
    if (!releases.every(isLegacyRelease))
      throw new Error("A non-legacy release exists. Do not replace the update key in place.");
    url = /<(https:\/\/api\.github\.com\/[^>]+)>;\s*rel="next"/.exec(
      response.headers.get("link") ?? "",
    )?.[1];
  }
  if (!found) throw new Error("Could not confirm Tor's legacy release history");
}

const key = importing
  ? createPrivateKey({ key: readFileSync(importing), format: "der", type: "pkcs8" })
  : generateKeyPairSync("ed25519").privateKey;
if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 update key");
const publicKey = Buffer.from(
  createPublicKey(key).export({ format: "jwk" }).x,
  "base64url",
).toString("base64");
if (importing && !pinned.includes(publicKey))
  throw new Error("That key does not match tinyjs.json");
const title = rotate
  ? `Tor update signing key ${new Date().toISOString().slice(0, 10)}`
  : "Tor update signing key";
const items = JSON.parse(run("op", ["item", "list", "--vault", vault, "--format", "json"]));
if (items.some((item) => item.title === title))
  throw new Error(`"${title}" already exists in "${vault}". Nothing was overwritten.`);
console.log(`Saving the update key to 1Password in "${vault}". Approve with Touch ID.`);
const result = JSON.parse(
  run("/bin/sh", ["-c", 'cat | op item create --vault "$1" --format json -', "sh", vault], {
    input: JSON.stringify({
      title,
      category: "PASSWORD",
      fields: [
        {
          id: "password",
          type: "CONCEALED",
          purpose: "PASSWORD",
          label: "password",
          value: key.export({ format: "der", type: "pkcs8" }).toString("base64"),
        },
      ],
    }),
    stdio: ["pipe", "pipe", "inherit"],
  }),
);
const ref = `op://${vault}/${title}/password`;
const stored = createPrivateKey({
  key: Buffer.from(
    run("op", ["read", "--no-newline", `op://${result.vault.id}/${result.id}/password`]),
    "base64",
  ),
  format: "der",
  type: "pkcs8",
});
if (!createPublicKey(stored).equals(createPublicKey(key)))
  throw new Error("1Password did not return the original key");
if (!importing) {
  config.update = { ...config.update, publicKey: rotate ? [...pinned, publicKey] : publicKey };
  writeFileSync("tinyjs.json", `${JSON.stringify(config, null, 2)}\n`);
}
console.log(`Saved: ${ref}\nPublic key: ${publicKey}`);
if (rotate) console.log("Publish once with the old key before selecting the new reference.");
