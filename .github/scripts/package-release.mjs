import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertApp } from "./app-signature.mjs";
import { run } from "./release-command.mjs";
import {
  ARCHES,
  MANIFEST,
  buildManifest,
  fileName,
  jsonFile,
  readConfig,
  releaseVersion,
  repositoryOf,
} from "./release-manifest.mjs";
import { assertNotes } from "./release-notes.mjs";

const [notesFile, out] = process.argv.slice(2);
if (!notesFile || !out) throw new Error("Usage: package-release.mjs NOTES_FILE OUTPUT_DIR");
const config = readConfig();
const version = releaseVersion(config.version);
const repo = repositoryOf(config);
if (process.env.GITHUB_REPOSITORY !== repo) throw new Error("Wrong release repository");
if (!/^[a-f0-9]{40}$/i.test(process.env.TINYJS_SIGN_IDENTITY ?? ""))
  throw new Error("A certificate-backed code signing identity is required");
const notes = readFileSync(notesFile, "utf8").trim();
assertNotes(notes);
mkdirSync(out, { recursive: true });

for (const arch of ARCHES) {
  const args = ["build", "--arch", arch, "--dmg"];
  try {
    run("tinyjs", args, { stdio: "inherit" });
  } catch {
    run("tinyjs", args, { stdio: "inherit" }); // retry a transient timestamp error
  }
  const app = join("dist", `${config.title}.app`);
  assertApp(app, config, arch);
  run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--keepParent",
    app,
    join(out, fileName(version, arch, "zip")),
  ]);
  const dmg = fileName(version, arch, "dmg");
  renameSync(join("dist", dmg), join(out, dmg));
}

writeFileSync(join(out, MANIFEST), jsonFile(buildManifest(config, repo, out, notes)));
