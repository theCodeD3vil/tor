import { run } from "./release-command.mjs";
import { repositoryOf } from "./release-manifest.mjs";

const [mode, extra] = process.argv.slice(2);
if (extra || !["--dry-run", "--prepare", "--apply"].includes(mode))
  throw new Error("Usage: release:github-settings --dry-run | --prepare | --apply");
const repo = repositoryOf();
const at = (path) => `repos/${repo}${path ? `/${path}` : ""}`;
const dryRun = mode === "--dry-run";
function api(method, path, body) {
  if (dryRun && method !== "GET") {
    console.log(`${method} ${at(path)}${body ? ` ${JSON.stringify(body)}` : ""}`);
    return;
  }
  const json = run(
    "gh",
    ["api", "--method", method, at(path), ...(body ? ["--input", "-"] : [])],
    body ? { input: JSON.stringify(body), stdio: ["pipe", "pipe", "inherit"] } : {},
  );
  return json ? JSON.parse(json) : null;
}

// This runner is deliberately opt-in. It never changes or deletes secrets.
const { owner } = api("GET", "");
const remoteRules =
  mode === "--prepare"
    ? []
    : JSON.parse(run("gh", ["api", "--paginate", "--slurp", at("rulesets?per_page=100")])).flat();
function ruleset(body) {
  const existing = remoteRules.find((rule) => rule.name === body.name);
  api(existing ? "PUT" : "POST", existing ? `rulesets/${existing.id}` : "rulesets", {
    ...body,
    enforcement: "active",
    bypass_actors: [],
  });
}

api("PUT", "environments/release", {
  wait_timer: 0,
  prevent_self_review: false,
  reviewers: [{ type: "User", id: owner.id }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});
const branches = dryRun
  ? []
  : api("GET", "environments/release/deployment-branch-policies").branch_policies;
if (branches.some(({ name, type }) => name !== "main" || type !== "branch"))
  throw new Error(
    "Remove any other deployment branch/tag patterns from the release environment before provisioning its secrets",
  );
if (!branches.length)
  api("POST", "environments/release/deployment-branch-policies", { name: "main", type: "branch" });
if (mode === "--prepare") {
  console.log(
    `Prepared ${repo}'s main-only release environment. No branch rules or secrets were changed.`,
  );
  process.exit(0);
}

api("PUT", "actions/permissions", {
  enabled: true,
  allowed_actions: "selected",
  sha_pinning_required: true,
});
api("PUT", "actions/permissions/selected-actions", {
  github_owned_allowed: true,
  verified_allowed: false,
  patterns_allowed: ["oven-sh/setup-bun@*"],
});
api("PUT", "actions/permissions/workflow", {
  default_workflow_permissions: "read",
  can_approve_pull_request_reviews: false,
});
api("PUT", "actions/permissions/fork-pr-contributor-approval", {
  approval_policy: "all_external_contributors",
});
ruleset({
  name: "Protect main",
  target: "branch",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        allowed_merge_methods: ["merge", "squash", "rebase"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: ["Typecheck", "Test", "Lint", "Format"].map((context) => ({
          context,
          integration_id: 15368,
        })),
      },
    },
  ],
});
ruleset({
  name: "Protect release tags",
  target: "tag",
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "update" }, { type: "non_fast_forward" }],
});
api("PUT", "immutable-releases");
api("PATCH", "", {
  security_and_analysis: {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  },
});
console.log(dryRun ? "Dry run only; nothing was changed." : `Release settings applied to ${repo}.`);
