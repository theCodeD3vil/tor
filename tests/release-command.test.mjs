import { afterEach, expect, test, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("an explicit plugin choice invokes the gh binary through 1Password", async () => {
  vi.stubEnv("TOR_GH", "op");
  const { ghCommand } = await import("../.github/scripts/release-command.mjs");
  expect(ghCommand()).toEqual(["op", "plugin", "run", "--", "gh"]);
});

test("GitHub Actions and op run may use the credential already supplied to gh", async () => {
  vi.stubEnv("TOR_GH", "");
  vi.stubEnv("GH_TOKEN", "fixture-not-a-secret");
  const { ghCommand } = await import("../.github/scripts/release-command.mjs");
  expect(ghCommand()).toEqual(["gh"]);
});
