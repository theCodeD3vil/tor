import { ghCommand, ghJson, run } from "./release-command.mjs";
import { repositoryOf } from "./release-manifest.mjs";

const repo = repositoryOf();
const releaseEnv = `repos/${repo}/environments/release`;
const environment = ghJson(["api", releaseEnv]);
const { branch_policies: policies } = ghJson(["api", `${releaseEnv}/deployment-branch-policies`]);
if (
  !environment.deployment_branch_policy?.custom_branch_policies ||
  !environment.protection_rules?.some(
    (rule) => rule.type === "required_reviewers" && rule.reviewers?.length,
  ) ||
  policies?.length !== 1 ||
  policies[0].name !== "main" ||
  policies[0].type !== "branch"
)
  throw new Error(
    "The release environment must allow only the main branch and require approval before receiving the certificate.",
  );
const vault = process.env.TOR_SIGNING_VAULT ?? "Personal";
const item = "Tor signing secrets";
const fields = ["MACOS_CERTIFICATE_P12", "MACOS_CERTIFICATE_PASSWORD"];
const details = JSON.parse(run("op", ["item", "get", item, "--vault", vault, "--format", "json"]));
if (fields.some((name) => !details.fields?.some((field) => field.label === name)))
  throw new Error(`"${item}" must have both macOS certificate fields`);
for (const name of fields) {
  // Only the macOS certificate fields go to CI, not the update key.
  run(
    "/bin/bash",
    [
      "-o",
      "pipefail",
      "-c",
      'op read --no-newline "$1" | "${@:4}" secret set "$2" --env release --repo "$3"',
      "bash",
      `op://${vault}/${item}/${name}`,
      name,
      repo,
      ...ghCommand(),
    ],
    { stdio: "inherit" },
  );
}
console.log(`Copied the macOS certificate fields to ${repo}'s release environment.`);
