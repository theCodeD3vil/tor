import { beforeAll, describe, expect, test, vi } from "vite-plus/test";

vi.mock("tjs:ffi", () => ({
  dlopen: () => ({
    symbols: {
      proc_pidpath: () => 0,
      responsibility_get_pid_responsible_for_pid: (pid: number) => pid,
    },
  }),
}));

type Attribution = typeof import("../backend/attribution");
let attr: Attribution;
beforeAll(async () => {
  vi.stubGlobal("tjs", { homeDir: "/Users/test" });
  attr = await import("../backend/attribution");
});

const GHOSTTY = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const ITERM = "/Applications/iTerm.app/Contents/MacOS/iTerm2";

/** [pid, ppid, executable path] rows, like one process scan */
function table(rows: [number, number, string][]) {
  return {
    paths: new Map(rows.map(([pid, , path]) => [String(pid), path])),
    parent: new Map(rows.map(([pid, ppid]) => [String(pid), String(ppid)])),
  };
}
const state = () => ({ responsibleOf: new Map(), sessionApp: new Map() });
const noHosts = () => attr.parseSessionHosts("", "", "");
/** responsible pids by pid; everything else is responsible for itself */
const owners =
  (map: Record<number, number>) =>
  (pid: number): number =>
    map[pid] ?? pid;

describe("app of an executable", () => {
  test("names the outermost real bundle and drops extensions", () => {
    expect(attr.appOf("/Applications/Safari.app/Contents/MacOS/Safari")).toEqual({
      name: "Safari",
      bundle: "/Applications/Safari.app",
    });
    expect(
      attr.appOf("/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/x"),
    ).toEqual({ name: "Slack", bundle: "/Applications/Slack.app" });
    expect(attr.appOf("/Users/test/bin/tool.app.sh")).toBeNull();
    expect(
      attr.appOf("/Applications/Vpn.app/Contents/PlugIns/Tunnel.appex/Contents/MacOS/Tunnel"),
    ).toBeNull();
  });

  test("files App Store daemons and Steam's real client under their apps", () => {
    expect(
      attr.appOf("/System/Library/PrivateFrameworks/AppStoreDaemon.framework/Support/appstoreagent")
        ?.name,
    ).toBe("App Store");
    expect(
      attr.appOf(
        "/Users/test/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/steam_osx",
      ),
    ).toEqual({ name: "Steam", bundle: "/Applications/Steam.app" });
  });
});

describe("process resolver", () => {
  test("a CLI counts toward the terminal responsible for it; system and unknown binaries differ", () => {
    const procs = table([
      [10, 1, GHOSTTY],
      [20, 10, "/bin/zsh"],
      [21, 20, "/usr/bin/curl"],
      [30, 1, "/usr/libexec/nsurlsessiond"],
      [31, 1, "/opt/homebrew/bin/syncthing"],
      [32, 1, "/Library/SystemExtensions/ABC/com.vpn.extension.systemextension/Contents/x"],
    ]);
    const resolve = attr.createResolver(procs, noHosts(), state(), owners({ 20: 10, 21: 10 }));
    expect(resolve("21")).toEqual({ name: "Ghostty", bundle: "/Applications/Ghostty.app" });
    expect(resolve("30")).toBeNull();
    expect(resolve("31")).toBe(attr.OTHER);
    expect(resolve("32")).toBeNull();
  });

  test("a tmux pane counts toward the terminal attached to its session, also once detached", () => {
    const procs = table([
      [10, 1, GHOSTTY],
      [40, 10, "/bin/zsh"],
      [41, 40, "/opt/homebrew/bin/tmux"], // client
      [50, 1, "/opt/homebrew/bin/tmux"], // server
      [51, 50, "/bin/zsh"], // pane
      [52, 51, "/usr/bin/git"],
    ]);
    const remembered = state();
    const attached = attr.parseSessionHosts("", "51 $1\n", "41 $1 100\n");
    const resolve = attr.createResolver(procs, attached, remembered, owners({ 40: 10, 41: 10 }));
    expect(resolve("52")?.name).toBe("Ghostty");
    // the terminal closed: the session keeps counting where it was last shown
    const detached = attr.parseSessionHosts("", "51 $1\n", "");
    expect(attr.createResolver(procs, detached, remembered, owners({}))("52")?.name).toBe(
      "Ghostty",
    );
  });

  test("the newest tmux client of a session wins", () => {
    const hosts = attr.parseSessionHosts("", "", "41 $1 100\n42 $1 300\n43 $1 200\n");
    expect(hosts.tmux.clients.get("$1")).toEqual({ pid: "42", activity: 300 });
  });

  test("another session host goes to the client sharing its session name", () => {
    const procs = table([
      [10, 1, GHOSTTY],
      [11, 1, ITERM],
      [60, 11, "/usr/bin/screen"], // client in iTerm, attached to "work"
      [70, 10, "/usr/bin/screen"], // newer client in Ghostty, another session
      [80, 1, "/usr/bin/screen"], // the "work" server
      [81, 80, "/bin/zsh"],
      [82, 81, "/usr/bin/ssh"],
    ]);
    const hosts = attr.parseSessionHosts(
      "60 screen -r work\n70 screen -r other\n80 SCREEN -S work\n",
      "",
      "",
    );
    const resolve = attr.createResolver(procs, hosts, state(), owners({ 60: 11, 70: 10 }));
    expect(resolve("82")?.name).toBe("iTerm");
  });

  test("an agent's service and what it runs get the agent's row, a GUI app keeps its own", () => {
    const procs = table([
      [10, 1, GHOSTTY],
      [90, 1, "/Users/test/.opencode/bin/opencode"],
      [91, 90, "/usr/bin/git"],
      [92, 90, "/Applications/Preview.app/Contents/MacOS/Preview"],
    ]);
    const resolve = attr.createResolver(procs, noHosts(), state(), owners({ 90: 10, 91: 10 }));
    expect(resolve("90")?.name).toBe("OpenCode");
    expect(resolve("91")?.name).toBe("OpenCode");
    expect(resolve("92")?.name).toBe("Preview");
  });

  test("a terminal's server counts toward the installed terminal app", () => {
    // osascript output: Rex not installed, Herdr and Setapp installed, OpenCode desktop not
    attr.applyAppPaths("\n/Applications/Herdr.app\n/Applications/Setapp.app\n\n");
    const herdr = { name: "Herdr", bundle: "/Applications/Herdr.app" };
    const procs = table([
      [10, 1, "/Users/test/.local/share/herdr-core/Herdr Core.app/Contents/MacOS/herdr-core"],
      [11, 10, "/bin/zsh"],
      [12, 11, "/usr/bin/curl"],
      [13, 1, "/Users/test/.local/bin/herdr-core"],
    ]);
    const resolve = attr.createResolver(procs, noHosts(), state(), owners({ 11: 10, 12: 10 }));
    expect(resolve("12")).toEqual(herdr);
    expect(resolve("13")).toEqual(herdr);
    // history saved under the server's own bundle moves to the app
    expect(
      attr.historicalApp("Herdr Core", "/Users/test/.local/share/herdr-core/Herdr Core.app"),
    ).toEqual(herdr);
    expect(attr.historicalApp("opencode", "")?.name).toBe("OpenCode");
    expect(attr.historicalApp("Safari", "/Applications/Safari.app")).toBeNull();
  });
  test("Setapp's helper bundles count toward the Setapp app, history included", () => {
    const setapp = { name: "Setapp", bundle: "/Applications/Setapp.app" };
    const agents = "/Users/test/Library/Application Support/Setapp/LaunchAgents";
    expect(attr.appOf(`${agents}/Setapp.app/Contents/MacOS/SetappAgent`)).toEqual(setapp);
    expect(attr.appOf(`${agents}/SetappLauncher.app/Contents/MacOS/SetappLauncher`)).toEqual(
      setapp,
    );
    expect(attr.appOf("/Applications/Setapp/CleanMyMac.app/Contents/MacOS/CleanMyMac")?.name).toBe(
      "CleanMyMac",
    );
    expect(attr.historicalApp("Setapp", `${agents}/Setapp.app`)).toEqual(setapp);
    expect(attr.historicalApp("Setapp", setapp.bundle)).toBeNull();
  });

  test("every launch of a translocated app shares one row", () => {
    const copy = (id: string) =>
      `/private/var/folders/fr/abc/T/AppTranslocation/${id}/d/Install Setapp 3.app`;
    const app = { name: "Install Setapp 3", bundle: "" };
    expect(attr.appOf(`${copy("D561-6410")}/Contents/MacOS/Install Setapp`)).toEqual(app);
    expect(attr.appOf(`${copy("DCBD-9016")}/Contents/MacOS/Install Setapp`)).toEqual(app);
    expect(attr.historicalApp("Install Setapp 3", copy("D561-6410"))).toEqual(app);
  });
});
