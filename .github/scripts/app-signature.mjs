import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "./release-command.mjs";

const LOOSENING_ENTITLEMENTS = [
  "com.apple.security.get-task-allow",
  "com.apple.security.cs.debugger",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.disable-executable-page-protection",
];

export function signatureProblems(name, details, entitlements) {
  const problems = [];
  const flags = /CodeDirectory [^\n]*flags=0x[0-9a-f]+\(([^)]*)\)/.exec(details)?.[1].split(",");
  if (!flags?.includes("runtime")) problems.push(`${name} has no hardened runtime`);
  if (
    !/^Authority=.+$/m.test(details) ||
    flags?.includes("adhoc") ||
    /^Signature=adhoc$/m.test(details)
  )
    problems.push(`${name} is not certificate-signed`);
  for (const key of LOOSENING_ENTITLEMENTS)
    if (entitlements.includes(key)) problems.push(`${name} has the entitlement ${key}`);
  return problems;
}

function codesign(args) {
  const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`codesign could not inspect ${args.at(-1)}`);
  return `${result.stdout}${result.stderr}`;
}

export function assertApp(app, config, arch) {
  const macos = join(app, "Contents", "MacOS");
  const helpers = join(app, "Contents", "Helpers");
  const binaries = [
    app,
    ...readdirSync(macos).map((name) => join(macos, name)),
    ...(existsSync(helpers) ? readdirSync(helpers).map((name) => join(helpers, name)) : []),
  ];
  run("/usr/bin/codesign", ["--verify", "--strict", "--deep", app]);
  const problems = binaries.flatMap((binary) =>
    signatureProblems(
      binary,
      codesign(["-dv", "--verbose=4", binary]),
      codesign(["-d", "--entitlements", "-", "--xml", binary]),
    ),
  );
  if (problems.length) throw new Error(problems.join("\n"));
  for (const name of [config.name, "tjs"])
    run("/usr/bin/lipo", [join(macos, name), "-verify_arch", arch]);
  const plist = join(app, "Contents", "Info.plist");
  for (const [key, expected] of [
    ["CFBundleIdentifier", config.id],
    ["CFBundleShortVersionString", config.version],
  ]) {
    if (run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]).trim() !== expected)
      throw new Error(`${app} does not have the expected ${key}`);
  }
}
