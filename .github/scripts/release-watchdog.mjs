import { createHash } from "node:crypto";
import { listReleases, run } from "./release-command.mjs";
import {
  MANIFEST,
  isLegacyRelease,
  publicKeys,
  publishedProblems,
  readConfig,
  repositoryOf,
} from "./release-manifest.mjs";

const config = readConfig();
const repo = repositoryOf(config);
const pins = publicKeys(config);
if (process.env.GITHUB_REPOSITORY !== repo || !process.env.GH_TOKEN)
  throw new Error("The watchdog must run in Tor's release repository");

const releases = listReleases(repo).filter((release) => !release.draft);
let failed = false;
for (const release of releases) {
  try {
    let manifest = null;
    const asset = release.assets.find((entry) => entry.name === MANIFEST);
    if (!isLegacyRelease(release) && asset && asset.size > 0 && asset.size <= 256_000) {
      // A transient download failure is never a reason to pull a release.
      const bytes = run(
        "gh",
        [
          "api",
          "-H",
          "Accept: application/octet-stream",
          `repos/${repo}/releases/assets/${asset.id}`,
        ],
        { encoding: null },
      );
      if (asset.digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`)
        throw new Error(
          "Downloaded manifest and GitHub asset digest differ; retry before taking action",
        );
      try {
        manifest = JSON.parse(bytes.toString("utf8"));
      } catch {
        // A successfully downloaded but malformed manifest is invalid.
      }
    }
    const problems = publishedProblems(release, manifest, repo, pins);
    if (!problems.length) continue;
    failed = true;
    let outcome = "was returned to draft";
    try {
      run("gh", [
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/releases/${release.id}`,
        "-F",
        "draft=true",
      ]);
    } catch {
      outcome = "could not be returned to draft; remove it manually if confirmed";
    }
    const title = `Release watchdog: release ${release.id} needs attention`;
    const issues = JSON.parse(
      run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/issues?state=open&per_page=100`]),
    ).flat();
    if (!issues.some((issue) => issue.title === title)) {
      run("gh", ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"], {
        input: `Release ID ${release.id} ${outcome}.\n\n${problems.map((reason) => `- ${reason.replace(/[<>\r\n]/g, " ")}`).join("\n")}\n`,
        stdio: ["pipe", "pipe", "inherit"],
      });
    }
  } catch (err) {
    failed = true;
    console.error(`Could not check release ${release.id}: ${String(err)}`);
  }
}
console.log(`Checked ${releases.length} published releases.`);
if (failed) process.exitCode = 1;
