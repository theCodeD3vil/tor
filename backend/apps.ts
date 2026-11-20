// Per-app network usage, grouped by bundle or CLI service.
// One `nettop` stream gives a cumulative per-process reading every second; deltas
// between readings are attributed to the app owning the pid. Icons come from
// NSWorkspace via JXA, rendered to a local cache and sent as data URLs.

import type {
  AppEntry,
  DailyUsage,
  DayUsage,
  Period,
  Stats,
  TopApp,
  UsageRow,
} from "../shared/types";
import { createNettopParser, type ProcSample } from "./nettop";

// nettop block-buffers when stdout is a pipe, so it runs under a pty (`script`): each
// reading arrives as soon as it is printed (CRLF line ends, handled in onLine).
// nettop's stdin is closed (`<&-`): with stdin at EOF it busy-loops at 100%+ CPU, and
// EOF is what it would get, since `script` forwards the app's /dev/null stdin into the
// pty as ^D. A pipe held open would do too, but `script` refuses the socketpair that
// tjs.spawn's `stdin: "pipe"` is, and macOS FIFOs are socket-backed as well.
// Interface types are listed instead of `-t external`: VPN tunnels (utun, type
// "undefined") don't count as external, so with a VPN up every app's traffic vanished
// and only the VPN daemon's did show. Loopback and AWDL stay out.
// Socket mode (no -P): each process row is followed by its sockets with their
// interface, which is what tells a VPN's carrier socket apart (see endSample).
const PS = "/bin/ps";
const OSASCRIPT = "/usr/bin/osascript";
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
// Finder and Login Items give the app a PATH without Homebrew, so a bare
// `tmux` never resolves in a packaged build. Probe the real locations.
let tmuxBin: string | null | undefined;
async function tmuxPath(): Promise<string | null> {
  if (tmuxBin !== undefined) return tmuxBin;
  tmuxBin = null;
  for (const path of TMUX_CANDIDATES) {
    try {
      await tjs.stat(path);
      tmuxBin = path;
      break;
    } catch {
      // not installed there
    }
  }
  return tmuxBin;
}
// -P drops the per-socket lines. Socket mode is only worth it while a utun
// interface is moving bytes (VPN carrier subtraction); otherwise it is
// thousands of lines a second for the interpreter to split.
function streamArgs(sockets: boolean): string[] {
  const flags = sockets ? "" : "-P ";
  return [
    "/usr/bin/script",
    "-q",
    "/dev/null",
    "/bin/sh",
    "-c",
    `exec /usr/bin/nettop -n -s 1 -L 0 -t wifi -t wired -t expensive -t undefined ${flags}-J interface,bytes_in,bytes_out -x <&-`,
  ];
}
// Count a VPN's encrypted UDP carrier separately only when both the port and
// its volume match the active tunnel. This is a heuristic, not a VPN detector.
const TUNNEL_PORTS = new Set([51820, 1194, 1195, 1197, 1198, 500, 4500, 1701]);
const CARRIER_MIN_BYTES = 4096;
const CARRIER_MATCH = { low: 0.4, high: 1.6 };
const NAMES_REFRESH_MS = 10_000; // unknown pids refresh immediately; this only catches renames
// nettop reports a process for a few more readings after it exits (its last bytes among
// them), so a pid that left `ps` keeps its app this long
const GONE_KEEP_MS = 15_000;
const ICON_PX = 64;
const ICON_RECHECK_MS = 10 * 60_000; // how often an app's bundle is looked at for a newer icon

// JXA: render an app's NSWorkspace icon to a PNG (args: bundle path, out path, px)
const ICON_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const [path, out] = argv;
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(path);
  const size = Number(argv[2]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    $(), size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  png.writeToFileAtomically(out, true);
}
`;

// macOS "responsible process": the app a process works on behalf of, e.g. the
// terminal behind a shell, `claude` or `curl`, or Safari behind its WebKit helpers.
// Private libSystem call, so fall back to the executable path. It does not reach
// into a detached session: its server is launched by launchd and is responsible for
// itself and for everything inside (see SESSION_HOSTS).
// libSystem is opened by its full path: the runtime tinyjs bundled up to txiki.js
// 26.6 could not resolve the bare name "c", so the lookup was silently missing and
// every terminal's traffic (curl, git, brew: no ".app" in their path) was dropped.
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
let responsiblePid: ((pid: number) => number) | null = null;
// Kernel vnode path, not the process-controlled ps `comm` label.
let procPath: ((pid: number) => string) | null = null;
let lookupError: string | null = null; // why responsiblePid is missing, reported by createAppTracker
try {
  const { dlopen } = await import("tjs:ffi");
  const { symbols } = dlopen(LIBSYSTEM, {
    responsibility_get_pid_responsible_for_pid: { args: ["i32"], returns: "i32" },
  });
  responsiblePid = (pid) => symbols.responsibility_get_pid_responsible_for_pid(pid);
} catch (err) {
  lookupError = err instanceof Error ? err.message : String(err);
  console.error("tor apps: responsible-pid lookup unavailable:", err);
}
try {
  const { dlopen } = await import("tjs:ffi");
  const { symbols } = dlopen(LIBSYSTEM, {
    proc_pidpath: { args: ["i32", "buffer", "u32"], returns: "i32" },
  });
  const pathBuf = new Uint8Array(4096);
  const decoder = new TextDecoder();
  procPath = (pid) => {
    const n = symbols.proc_pidpath(pid, pathBuf, pathBuf.length);
    if (n <= 0) return "";
    return decoder.decode(pathBuf.subarray(0, n));
  };
} catch (err) {
  console.error("tor apps: process paths unavailable:", err);
}

async function run(args: string[]): Promise<string> {
  const proc = tjs.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const text = await proc.stdout!.text();
  const status = await proc.wait();
  if (status.exit_status !== 0) throw new Error(`${args[0]} exited with ${status.exit_status}`);
  return text;
}

// "" when the command is missing or fails (no tmux, or no server running)
async function tryRun(args: string[]): Promise<string> {
  try {
    return await run(args);
  } catch {
    return "";
  }
}

// Detached session hosts: a server that outlives the terminal and is reparented to
// launchd (tmux, screen, zellij, dtach, abduco, ...), so the responsible-process
// lookup stops at it and everything inside is unattributed. The terminal is only
// reachable through the client: an ordinary child of the terminal's shell running the
// same program, whose responsible process is the terminal app. The server's subtree
// is attributed to its newest client, matched by a shared argument (a socket path or
// session name) when the server has several; tmux knows its sessions, so its panes
// are mapped to the client attached to their own session. Adding a host: its
// executable name below, and a precise mapping if the generic one is too coarse.
const SESSION_HOSTS = new Set(["tmux", "screen", "zellij", "dtach", "abduco"]);

interface SessionHosts {
  tmux: {
    panes: Map<string, string>; // pane_pid → session id
    clients: Map<string, { pid: string; activity: number }>; // session id → newest client
  };
  args: Map<string, string[]>; // pid → argv (without argv[0]) of the host processes
}

function hostName(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return SESSION_HOSTS.has(name) ? name : null;
}

async function readSessionHosts(paths: Map<string, string>): Promise<SessionHosts> {
  const hosts: SessionHosts = { tmux: { panes: new Map(), clients: new Map() }, args: new Map() };
  const hostPids = [...paths].filter(([, path]) => hostName(path)).map(([pid]) => pid);
  if (!hostPids.length) return hosts;
  const tmux = hostPids.some((pid) => hostName(paths.get(pid) ?? "") === "tmux")
    ? await tmuxPath()
    : null;
  const [argsOut, paneOut, clientOut] = await Promise.all([
    tryRun([PS, "-o", "pid=,args=", "-p", hostPids.join(",")]),
    tmux
      ? tryRun([tmux, "list-panes", "-a", "-F", "#{pane_pid} #{session_id}"])
      : Promise.resolve(""),
    tmux
      ? tryRun([tmux, "list-clients", "-F", "#{client_pid} #{session_id} #{client_activity}"])
      : Promise.resolve(""),
  ]);
  for (const line of argsOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) hosts.args.set(m[1], m[2].split(/\s+/).slice(1).filter(Boolean));
  }
  for (const line of paneOut.split("\n")) {
    const [pid, session] = line.trim().split(" ");
    if (pid && session) hosts.tmux.panes.set(pid, session);
  }
  for (const line of clientOut.split("\n")) {
    const [pid, session, activity] = line.trim().split(" ");
    if (!pid || !session) continue;
    const at = Number(activity) || 0;
    const cur = hosts.tmux.clients.get(session);
    if (!cur || at >= cur.activity) hosts.tmux.clients.set(session, { pid, activity: at });
  }
  return hosts;
}

// Outermost .app of an executable path — null for daemons, CLIs and system internals
interface AppRef {
  name: string;
  bundle: string;
}

// Processes that move bytes for an app without living in its bundle: system daemons
// that download for the App Store, and Steam, whose /Applications/Steam.app is only a
// bootstrapper for a client installed under Application Support (no ".app/" in its
// path, and its helpers sit in a nested "Steam Helper.app").
// Terminals with a server (Rex, Herdr) are the other kind: the window is one app, the
// shells run under a server bundle launched by launchd ("Rex Server.app", "Herdr
// Core.app", or a bare herdr-core binary), which is their responsible process, so
// all the traffic of what runs inside would be filed under the server, or dropped
// when its path has no .app in it. Those servers are looked up by the bundle id of
// the window app they belong to (see resolveAliases), so moving the app is fine.
const HOME = tjs.homeDir;
const APP_STORE: AppRef = { name: "App Store", bundle: "/System/Applications/App Store.app" };
const STEAM: AppRef = { name: "Steam", bundle: "/Applications/Steam.app" };
const APP_ALIASES: { prefix: string; app: AppRef }[] = [
  { prefix: "/System/Library/PrivateFrameworks/AppStoreDaemon.framework/", app: APP_STORE },
  { prefix: "/System/Library/PrivateFrameworks/CommerceKit.framework/", app: APP_STORE },
  { prefix: "/System/Applications/App Store.app/", app: APP_STORE },
  { prefix: `${HOME}/Library/Application Support/Steam/`, app: STEAM },
];
// server paths → the bundle id of the terminal app that shows them
const SERVER_ALIASES: { prefixes: string[]; bundleId: string }[] = [
  {
    prefixes: [`${HOME}/Library/Application Support/com.superlogical.rex/`],
    bundleId: "com.superlogical.rex", // Rex (Beta): "Rex Server.app" under Application Support
  },
  {
    prefixes: [`${HOME}/.local/share/herdr-core/`, `${HOME}/.local/bin/herdr-core`],
    bundleId: "dev.herdr.app", // Herdr: "Herdr Core.app" (or a bare herdr-core) under ~/.local
  },
];

// Coding agents that make their model calls from one background service shared by every
// terminal: opencode starts "opencode serve --service" under launchd the first time and
// every later session, from any terminal, only talks to it over loopback. Its responsible
// process is whichever app started it first (Herdr, say), so all sessions' traffic would
// be filed under that app, and no terminal could be told apart anyway. The service, and
// what it runs for the agent, get a row of their own instead. Only processes with no
// .app of their own are claimed: a GUI app an agent opens keeps its row. Adding an
// agent: the name of its executable below.
const AGENT_SERVICES: { exe: string; bundleId: string; app: AppRef }[] = [
  { exe: "opencode", bundleId: "ai.opencode.desktop", app: { name: "OpenCode", bundle: "" } },
];
// Everything that is not a real app and not an Apple system binary. Hidden
// launchd agents and CLIs used to vanish from the totals.
const OTHER: AppRef = { name: "System & CLI", bundle: "" };
const SYSTEM_PREFIXES = ["/System/Library/", "/usr/libexec/", "/usr/sbin/", "/usr/lib/"];

// JXA: where NSWorkspace finds the app with each bundle id (one path per line, "" if none)
const APP_PATHS_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  return argv.map((id) => {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
    return url.isNil() ? "" : url.path.js;
  }).join("\\n");
}
`;

// Add an alias per installed terminal app for the server paths that run on its behalf.
// Apps not installed are skipped: their servers cannot be running either. An agent's row
// (AGENT_SERVICES) gets the bundle of its desktop app when that is installed.
async function resolveAliases(dir: string): Promise<void> {
  const script = `${dir}/apppaths.jxa.js`;
  await tjs.writeFile(script, APP_PATHS_SCRIPT);
  const ids = [...SERVER_ALIASES, ...AGENT_SERVICES].map((a) => a.bundleId);
  const out = await tryRun([OSASCRIPT, "-l", "JavaScript", script, ...ids]);
  const lines = out.replace(/\n$/, "").split("\n");
  SERVER_ALIASES.forEach(({ prefixes }, i) => {
    const bundle = lines[i];
    const name = bundle?.match(/([^/]+)\.app$/)?.[1];
    if (!bundle || !name) return;
    for (const prefix of prefixes) APP_ALIASES.push({ prefix, app: { name, bundle } });
  });
  AGENT_SERVICES.forEach(({ app }, i) => {
    const bundle = lines[SERVER_ALIASES.length + i];
    if (bundle?.startsWith("/") && bundle.endsWith(`/${app.name}.app`)) app.bundle = bundle;
  });
}

function isExtension(path: string): boolean {
  // Network Extensions carry other apps' traffic: counting them counts it twice
  return path.startsWith("/Library/SystemExtensions/") || /\.(appex|systemextension)\//.test(path);
}

function isSystem(path: string): boolean {
  return SYSTEM_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function aliasOf(path: string): AppRef | null {
  for (const { prefix, app } of APP_ALIASES) {
    if (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix) return app;
  }
  return null;
}

function appOf(path: string): AppRef | null {
  if (isExtension(path)) return null;
  const alias = aliasOf(path);
  if (alias) return alias;
  // A real bundle has Contents/. A path that merely contains ".app" does not.
  const m = path.match(/^(.*?\/([^/]+)\.app)\/Contents\//);
  return m ? { name: m[2], bundle: m[1] } : null;
}

const PERIOD_DAYS: Record<Period, number> = { today: 1, "7d": 7, "30d": 30 };
const KEEP_DAYS = 90;

// local calendar day, e.g. "2026-11-04"
function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return dayKey(date);
}

export interface AppTracker {
  /** `period` may also be a count of days */
  top(n: number, period?: Period | number): TopApp[];
  /** stop nettop (offline, asleep); the per-process baselines are kept, so the first
   *  reading after resume() yields exactly the bytes moved in between */
  pause(): void;
  resume(): void;
  /** Writes changed rows and their prunes; failed writes leave rows dirty. */
  flushDirty(
    save: (
      rows: UsageRow[],
      pruneBefore: string,
      remove: { day: string; app: string; bundle: string }[],
    ) => void,
  ): void;
  /** the last `range` days: daily totals, overall totals, and the usual suspects */
  stats(range?: number): Stats;
  todayTotals(): { down: number; up: number };
  /** an app's icon (PNG path) when known; starts rendering it from its bundle otherwise */
  icon(app: AppRef): string | null;
  /** forget the cached sums (the hidden apps changed) */
  invalidate(): void;
  /** per-socket nettop only while a VPN tunnel is moving bytes */
  setTunnelActive(active: boolean): void;
  stop(): Promise<void>;
}

/**
 * @param tempDir scratch dir for the JXA scripts
 * @param saved per-day, per-app totals from an earlier run (the 7d / 30d history)
 * @param iconDir where icon PNGs are kept across launches
 * @param paused start without nettop (the Mac is offline); resume() starts it
 * @param isIgnored apps the user hid: still recorded, left out of top() and stats().
 *   A pinned bundle only hides that bundle, not another app with the same name.
 * @param onProblem told about anything that makes the counts incomplete (so it can be logged)
 */
export async function createAppTracker(
  tempDir: string,
  saved: DailyUsage = {},
  {
    paused = false,
    isIgnored = (_name: string, _bundle = ""): boolean => false,
    iconDir,
    onProblem = (_message: string): void => {},
  }: {
    paused?: boolean;
    isIgnored?: (name: string, bundle: string) => boolean;
    iconDir: string;
    onProblem?: (message: string) => void;
  },
): Promise<AppTracker> {
  if (lookupError) {
    onProblem(
      `responsible-process lookup unavailable (${lookupError}): some terminal traffic may appear under System & CLI`,
    );
  }
  const daily = saved;
  const touched = new Set<string>(); // "day\0id" rows changed since the last save
  const removed: { day: string; app: string; bundle: string }[] = []; // rows merged into another app
  let lastPrune = "";
  const scriptDir = await tjs.makeTempDir(`${tempDir}/tor-apps-XXXXXX`);
  const iconScript = `${scriptDir}/icon.jxa.js`;
  await tjs.writeFile(iconScript, ICON_SCRIPT);
  await tjs.makeDir(iconDir, { recursive: true });
  await resolveAliases(scriptDir);
  // History recorded under a server's own name before its alias existed ("Herdr Core",
  // "Rex Server"), or under a row's earlier name ("opencode"), is folded into the app it
  // stands for, so the list shows one entry
  for (const [day, apps] of Object.entries(daily)) {
    for (const [key, v] of Object.entries(apps)) {
      const previous = v.name || key;
      const agent =
        !v.bundle &&
        AGENT_SERVICES.find(({ exe, app }) => previous === exe || previous === app.name);
      const app =
        (agent ? agent.app : null) ?? (v.bundle ? aliasOf(`${v.bundle}/Contents/`) : null);
      const id = app ? app.bundle || app.name : key;
      const display = app?.name ?? previous;
      v.name = display;
      if (key === id) {
        if (previous !== display) {
          touched.add(`${day}\0${id}`);
          removed.push({ day, app: previous, bundle: v.bundle });
        }
        continue;
      }
      const into = (apps[id] ??= { down: 0, up: 0, bundle: v.bundle, name: display });
      into.down += v.down;
      into.up += v.up;
      into.bundle = app?.bundle || v.bundle;
      into.name = display;
      delete apps[key];
      touched.add(`${day}\0${id}`);
      removed.push({ day, app: previous, bundle: v.bundle });
    }
  }
  const pids = new Map<string, AppRef | null>(); // pid → app | null (drop: extension or Apple system)
  const pidPath = new Map<string, string>(); // pid → vnode path last refresh, to spot reuse
  const gone = new Map<string, number>(); // pid → when it was last missing from ps
  const sessionApp = new Map<string, { app: AppRef; seen: number }>();
  const last = new Map<string, { in: number; out: number }>(); // pid → cumulative at the previous reading
  const lastSock = new Map<string, { in: number; out: number }>(); // "pid|socket" → cumulative at the previous reading
  const responsibleOf = new Map<string, { path: string; pid: number }>();
  const sampleSeen = new Map<string, number>();
  const pending = new Map<string, { down: number; up: number; since: number }>();
  const icons = new Map<string, { url: string; path: string; revision: number }>();
  let iconRevision = 0;
  const iconChecked = new Map<string, number>(); // identity → when its bundle was last looked at
  let proc: ReturnType<typeof tjs.spawn> | undefined; // the running nettop (via script)
  let restart: ReturnType<typeof setTimeout> | undefined;
  let streamSeq = 0; // which stream() is current: an older one ending must not restart
  let refreshing: Promise<void> | null = null;
  let again = false; // a pid showed up while a refresh was awaiting ps
  let stopped = false;
  let socketMode = false;

  function forgetPid(pid: string): void {
    forgetSample(pid);
    for (const key of lastSock.keys()) if (key.startsWith(`${pid}|`)) lastSock.delete(key);
    responsibleOf.delete(pid);
    pidPath.delete(pid);
  }

  function forgetSample(pid: string): void {
    last.delete(pid);
    sampleSeen.delete(pid);
  }

  function expireTraffic(now: number): void {
    for (const [pid, bytes] of pending) {
      if (now - bytes.since < GONE_KEEP_MS) continue;
      // The process was too short-lived for ps; the bytes still belong in totals.
      add(OTHER, bytes.down, bytes.up);
      pending.delete(pid);
    }
    for (const [pid, at] of sampleSeen)
      if (!pids.has(pid) && now - at >= GONE_KEEP_MS) forgetSample(pid);
    for (const [key, entry] of sessionApp)
      if (now - entry.seen >= 10 * 60_000) sessionApp.delete(key);
  }

  function refreshPids(): Promise<void> {
    again = true;
    refreshing ??= (async () => {
      while (again && !stopped) {
        again = false;
        const paths = new Map<string, string>();
        const parent = new Map<string, string>();
        for (const line of (await run([PS, "-axo", "pid=,ppid="])).split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
          if (!m) continue;
          paths.set(m[1], procPath?.(Number(m[1])) ?? "");
          parent.set(m[1], m[2]);
        }
        const hosts = await readSessionHosts(paths);
        if (stopped) return;
        const direct = (pid: string): AppRef | null => {
          const path = paths.get(pid);
          if (!path || isExtension(path)) return null;
          const cached = responsibleOf.get(pid);
          const owner =
            cached && cached.path === path ? cached.pid : (responsiblePid?.(Number(pid)) ?? 0);
          responsibleOf.set(pid, { path, pid: owner });
          const ownerPath = owner > 0 ? paths.get(String(owner)) : undefined;
          return (ownerPath && appOf(ownerPath)) || appOf(path);
        };
        // an agent's service, or something it runs: its own row, ahead of the responsible app
        const agentOf = (pid: string): AppRef | null => {
          if (appOf(paths.get(pid) ?? "")) return null; // an app of its own keeps its row
          for (let p: string | undefined = pid, hops = 0; p && p !== "1" && hops < 64; hops++) {
            const path = paths.get(p) ?? "";
            const exe = path.slice(path.lastIndexOf("/") + 1);
            const agent = AGENT_SERVICES.find((a) => a.exe === exe);
            if (agent) return agent.app;
            p = parent.get(p);
          }
          return null;
        };
        // the terminal behind a session: its client's app now, else the one last seen,
        // so a detached session keeps counting where it was shown
        const remember = (key: string, app: AppRef | null): AppRef | null => {
          const entry = app ?? sessionApp.get(key)?.app;
          if (entry) sessionApp.set(key, { app: entry, seen: Date.now() });
          return entry ?? null;
        };
        const tmuxSession = (session: string): AppRef | null => {
          const client = hosts.tmux.clients.get(session);
          return remember(`tmux:${session}`, client ? direct(client.pid) : null);
        };
        // a host server's client: same program under a terminal, sharing an argument
        // (socket path, session name) with the server when any client does
        const hostClient = (server: string, name: string): AppRef | null => {
          const serverArgs = new Set(hosts.args.get(server) ?? []);
          let best: { pid: number; shared: boolean; app: AppRef } | null = null;
          for (const [pid, path] of paths) {
            if (pid === server || hostName(path) !== name) continue;
            const app = direct(pid);
            if (!app) continue;
            const shared = (hosts.args.get(pid) ?? []).some((arg) => serverArgs.has(arg));
            const n = Number(pid);
            if (!best || (shared && !best.shared) || (shared === best.shared && n > best.pid)) {
              best = { pid: n, shared, app };
            }
          }
          return remember(`${name}:${server}`, best?.app ?? null);
        };
        // a process inside a session: walk up to the pane (tmux) or to the host server
        const sessionHostApp = (pid: string): AppRef | null => {
          for (let p: string | undefined = pid, hops = 0; p && p !== "1" && hops < 64; hops++) {
            const session = hosts.tmux.panes.get(p);
            if (session) return tmuxSession(session);
            const name = hostName(paths.get(p) ?? "");
            if (name && parent.get(p) === "1") return hostClient(p, name);
            p = parent.get(p);
          }
          return null;
        };
        const next = new Map<string, AppRef | null>();
        for (const pid of paths.keys()) {
          const path = paths.get(pid) ?? "";
          const known = pidPath.get(pid);
          if (gone.has(pid) || (known && path && known !== path)) forgetPid(pid);
          pidPath.set(pid, path);
          let app = isExtension(path) ? null : (agentOf(pid) ?? direct(pid) ?? sessionHostApp(pid));
          // not an app and not an Apple binary: keep it visible instead of dropping it
          if (!app && !isSystem(path) && !isExtension(path)) app = OTHER;
          next.set(pid, app);
        }
        // just exited: keep the app for the readings nettop still prints for it
        const now = Date.now();
        for (const [pid, app] of pids) {
          if (paths.has(pid)) continue;
          const since = gone.get(pid) ?? now;
          if (now - since < GONE_KEEP_MS) {
            gone.set(pid, since);
            next.set(pid, app);
          } else forgetPid(pid); // recycled pids must not inherit this baseline
        }
        for (const pid of gone.keys()) if (!next.has(pid) || paths.has(pid)) gone.delete(pid);
        for (const pid of responsibleOf.keys()) if (!next.has(pid)) responsibleOf.delete(pid);
        pids.clear();
        for (const [pid, app] of next) pids.set(pid, app);
        for (const [pid, bytes] of pending) {
          if (!pids.has(pid)) continue; // showed up after ps: the next pass keeps it
          const app = pids.get(pid);
          if (app) add(app, bytes.down, bytes.up);
          pending.delete(pid);
        }
      } // again: a pid arrived while this pass was awaiting ps
    })()
      .catch((err) => console.error("tor apps ps:", err))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  function identity(app: AppRef): string {
    return app.bundle || app.name;
  }

  // Rendered once per app and kept across launches. The page gets a data URL,
  // so it does not need readAccess to the icon directory. A missing bundle is
  // remembered for ICON_RECHECK_MS instead of being statted on every poll.
  function loadIcon(app: AppRef): void {
    if (!app.bundle) return;
    const id = identity(app);
    const now = Date.now();
    const checked = iconChecked.get(id);
    if (checked !== undefined && now - checked < ICON_RECHECK_MS) return;
    iconChecked.set(id, now);
    void (async () => {
      const stat = await tjs.stat(app.bundle);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(app.bundle));
      const fingerprint = [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const out = `${iconDir}/${fingerprint}-${stat.mtim.getTime()}.png`;
      const known = icons.get(id);
      if (known?.path === out || stopped) return;
      const file = await tjs.stat(out).catch(() => null);
      if (!file)
        await run([OSASCRIPT, "-l", "JavaScript", iconScript, app.bundle, out, String(ICON_PX)]);
      if ((file ?? (await tjs.stat(out))).size > 96_000 || stopped) return;
      const bytes = await tjs.readFile(out);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      icons.set(id, {
        path: out,
        url: `data:image/png;base64,${btoa(binary)}`,
        revision: ++iconRevision,
      });
      if (known) void tjs.remove(known.path).catch(() => {});
    })().catch(() => {
      // Keep the old icon and retry only after ICON_RECHECK_MS.
    });
  }

  // Sums are read far more often than written (the tray repaints every second, the
  // popover polls twice a second), so each is computed once and kept until the next
  // add(), the day rolls over, or the hidden apps change (invalidate()).
  const sums = new Map<string, unknown>();
  let sumsDay = "";
  function cached<T>(key: string, compute: () => T): T {
    const today = dayKey(new Date());
    if (today !== sumsDay) {
      sums.clear();
      sumsDay = today;
    }
    if (sums.has(key)) return sums.get(key) as T;
    const value = compute();
    sums.set(key, value);
    return value;
  }

  function add(app: AppRef, down: number, up: number): void {
    const day = dayKey(new Date());
    const today = (daily[day] ??= Object.create(null) as Record<string, AppEntry>);
    const id = identity(app);
    const entry = (today[id] ??= { down: 0, up: 0, bundle: app.bundle, name: app.name });
    entry.down += down;
    entry.up += up;
    entry.name = app.name;
    entry.bundle = app.bundle;
    touched.add(`${day}\0${id}`);
    sums.clear();
  }

  // sum of the last `days` calendar days, today included (shared: do not mutate)
  function history(days: number): Map<string, AppEntry> {
    return cached(`history:${days}`, () => sumHistory(days));
  }

  function sumHistory(days: number): Map<string, AppEntry> {
    const totals = new Map<string, AppEntry>();
    for (let i = 0; i < days; i++) {
      const day = daily[daysAgo(i)];
      for (const [name, v] of Object.entries(day ?? {})) {
        if (isIgnored(v.name || name, v.bundle)) continue;
        const t = totals.get(name) ?? { down: 0, up: 0, bundle: v.bundle, name: v.name };
        t.down += v.down;
        t.up += v.up;
        t.name = v.name || t.name;
        totals.set(name, t);
      }
    }
    return totals;
  }

  function totalsForDay(day: string): DayUsage {
    return cached(`day:${day}`, () => {
      let down = 0;
      let up = 0;
      for (const [id, v] of Object.entries(daily[day] ?? {})) {
        if (isIgnored(v.name || id, v.bundle)) continue;
        down += v.down;
        up += v.up;
      }
      return { day, down, up };
    });
  }

  function endSample(procs: ProcSample[], establish: boolean, sockets: boolean): void {
    const now = Date.now();
    expireTraffic(now);
    const delta = (
      map: Map<string, { in: number; out: number }>,
      key: string,
      cur: { in: number; out: number },
    ): { down: number; up: number } => {
      const prev = map.get(key);
      map.set(key, cur);
      // first seen after priming: a new process/socket, all its bytes are new
      const base = prev ?? (establish ? cur : { in: 0, out: 0 });
      return { down: Math.max(0, cur.in - base.in), up: Math.max(0, cur.out - base.out) };
    };
    // pass 1: socket deltas; what the tunnels moved, and the UDP sockets that might carry it
    const seen = new Set<string>();
    let tunnel = 0;
    const udp: { proc: ProcSample; down: number; up: number; port: number }[] = [];
    const perProc = new Map<ProcSample, { down: number; up: number }>();
    for (const proc of procs) {
      sampleSeen.set(proc.pid, now);
      perProc.set(proc, delta(last, proc.pid, proc));
      for (const sock of proc.sockets) {
        const key = `${proc.pid}|${sock.key}`;
        seen.add(key);
        const d = delta(lastSock, key, sock);
        if (!d.down && !d.up) continue;
        if (sock.iface.startsWith("utun")) tunnel += d.down + d.up;
        else if (sock.udp && sock.iface && !sock.iface.startsWith("lo")) {
          udp.push({ proc, ...d, port: sock.remotePort });
        }
      }
    }
    // a process-only sample has no sockets; wiping baselines here would
    // double-count them the next time socket mode starts
    if (sockets) for (const key of lastSock.keys()) if (!seen.has(key)) lastSock.delete(key);
    // pass 2: a known tunnel port counts as the carrier only when it also
    // moves about as much as the tunnel. A quiet utun must not zero every
    // flow to those ports, and a QUIC flow must not match on size alone.
    if (tunnel >= CARRIER_MIN_BYTES) {
      for (const c of udp) {
        if (!TUNNEL_PORTS.has(c.port)) continue;
        const total = c.down + c.up;
        if (total < tunnel * CARRIER_MATCH.low || total > tunnel * CARRIER_MATCH.high) continue;
        const d = perProc.get(c.proc)!;
        d.down = Math.max(0, d.down - c.down);
        d.up = Math.max(0, d.up - c.up);
      }
    }
    // pass 3: attribute to apps
    for (const [proc, d] of perProc) {
      if (!d.down && !d.up) continue;
      if (!pids.has(proc.pid)) {
        const p = pending.get(proc.pid) ?? { down: 0, up: 0, since: now };
        p.down += d.down;
        p.up += d.up;
        pending.set(proc.pid, p);
        void refreshPids();
        continue;
      }
      const app = pids.get(proc.pid);
      if (app) add(app, d.down, d.up);
    }
  }

  function stream(): void {
    if (stopped || paused || proc) return;
    clearTimeout(restart);
    const id = ++streamSeq;
    runStream(socketMode)
      .catch((err) => console.error("tor apps stream:", err))
      .finally(() => {
        // nettop ended unexpectedly (it was killed, or the pty closed): start it again,
        // unless this is a pause or a stop, or a newer stream has already replaced it
        if (!stopped && !paused && id === streamSeq) restart = setTimeout(stream, 1000);
      });
  }

  async function runStream(sockets: boolean): Promise<void> {
    const p = tjs.spawn(streamArgs(sockets), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc = p;
    let priming = true;
    const feed = createNettopParser((sample) => {
      endSample(sample, priming, sockets);
      priming = false;
    });
    const reader = p.stdout!.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || proc !== p) break;
        feed(value);
      }
    } finally {
      reader.releaseLock();
      if (proc === p) proc = undefined;
    }
  }

  function killStream(): void {
    streamSeq++;
    clearTimeout(restart);
    const p = proc;
    proc = undefined;
    try {
      p?.kill();
    } catch {
      // already exited
    }
  }

  function top(n: number, period: Period | number = "today"): TopApp[] {
    const source = history(typeof period === "number" ? period : (PERIOD_DAYS[period] ?? 1));
    return [...source.entries()]
      .map(([id, v]) => {
        const icon = icons.get(v.bundle || id);
        return {
          name: v.name || id,
          bundle: v.bundle,
          down: v.down,
          up: v.up,
          icon: icon?.url ?? null,
          iconRevision: icon?.revision,
        };
      })
      .sort((a, b) => b.down + b.up - (a.down + a.up))
      .slice(0, n)
      .map((a) => {
        if (a.bundle) loadIcon({ name: a.name, bundle: a.bundle });
        return a;
      });
  }

  await refreshPids();
  const pidTimer = setInterval(() => {
    if (!paused) {
      expireTraffic(Date.now());
      void refreshPids();
    }
  }, NAMES_REFRESH_MS);
  stream();

  return {
    top,
    pause() {
      if (paused) return;
      paused = true;
      killStream();
    },
    resume() {
      if (!paused) return;
      paused = false;
      void refreshPids().then(stream); // refresh attribution before the first frame
    },
    flushDirty(save) {
      const pruneBefore = daysAgo(KEEP_DAYS - 1);
      if (!touched.size && !removed.length && lastPrune === pruneBefore) return;
      const rows = [...touched].flatMap((key): UsageRow[] => {
        const cut = key.indexOf("\0");
        const day = key.slice(0, cut);
        const id = key.slice(cut + 1);
        const v = daily[day]?.[id];
        if (!v) return [];
        return [{ day, app: v.name || id, down: v.down, up: v.up, bundle: v.bundle ?? "" }];
      });
      save(rows, pruneBefore, [...removed]);
      touched.clear();
      removed.length = 0;
      lastPrune = pruneBefore;
      for (const day of Object.keys(daily)) if (day < pruneBefore) delete daily[day];
      sums.clear();
    },
    todayTotals: () => totalsForDay(dayKey(new Date())),
    stats(range = 30) {
      const days: DayUsage[] = [];
      for (let i = range - 1; i >= 0; i--) {
        days.push(totalsForDay(daysAgo(i)));
      }
      const totals = days.reduce((t, d) => ({ down: t.down + d.down, up: t.up + d.up }), {
        down: 0,
        up: 0,
      });
      const withData = days.filter((d) => d.down + d.up > 0);
      const busiest = withData.reduce<DayUsage | null>(
        (best, d) => (!best || d.down + d.up > best.down + best.up ? d : best),
        null,
      );
      const [topApp] = top(1, range);
      return {
        days,
        totals,
        busiest,
        topApp: topApp ?? null,
        // average over the days that actually recorded traffic
        avgPerDay: withData.length ? (totals.down + totals.up) / withData.length : 0,
      };
    },
    icon(app) {
      if (app.bundle) {
        loadIcon(app);
        return icons.get(app.bundle)?.url ?? null;
      }
      for (const day of Object.values(daily)) {
        for (const [id, v] of Object.entries(day)) {
          if ((v.name || id) !== app.name || !v.bundle) continue;
          loadIcon({ name: app.name, bundle: v.bundle });
          return icons.get(v.bundle)?.url ?? null;
        }
      }
      return null;
    },
    invalidate() {
      sums.clear();
    },
    /** socket lines are only collected while a utun interface is moving bytes */
    setTunnelActive(active: boolean) {
      if (active === socketMode) return;
      socketMode = active;
      lastSock.clear(); // socket baselines from the other mode are not comparable
      if (stopped || paused) return;
      killStream();
      stream();
    },
    async stop() {
      stopped = true;
      clearInterval(pidTimer);
      killStream();
      await tjs.remove(scriptDir).catch(() => {});
    },
  };
}
