import { spawnSync } from "node:child_process";

let ghLauncher;

/** A child process does not inherit the interactive shell's gh function. */
export function ghCommand() {
  if (ghLauncher) return ghLauncher;
  const choice = process.env.TOR_GH;
  if (choice && choice !== "gh" && choice !== "op") throw new Error("TOR_GH must be gh or op");
  if (choice === "op") ghLauncher = ["op", "plugin", "run", "--", "gh"];
  else if (
    choice === "gh" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { stdio: "ignore" }).status ===
      0
  )
    ghLauncher = ["gh"];
  else ghLauncher = ["op", "plugin", "run", "--", "gh"];
  return ghLauncher;
}

export function run(command, args, options = {}) {
  const [program, ...launcherArgs] = command === "gh" ? ghCommand() : [command];
  const { status, error, stdout } = spawnSync(program, [...launcherArgs, ...args], {
    encoding: "utf8",
    stdio: [program === "op" && command === "gh" ? "inherit" : "ignore", "pipe", "inherit"],
    maxBuffer: 16_000_000,
    ...options,
  });
  if (status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed`, { cause: error });
  return stdout;
}

export const ghJson = (args) => JSON.parse(run("gh", args));
export const listReleases = (repo) =>
  ghJson(["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]).flat();
